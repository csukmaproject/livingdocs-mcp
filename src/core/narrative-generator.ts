import type { NodeChange, ChangeClassification } from "./ast-diff.js";
import type { LlmAdapter } from "./llm-adapter.js";
import type { DocGraph, DocNode } from "./types.js";

// Section 9.1 of docgen-plugin-plan.md: only contract-affecting changes
// (and brand-new nodes) proceed to the model. Cosmetic edits keep their
// previously-generated narrative untouched.
const NEEDS_GENERATION: ReadonlySet<ChangeClassification> = new Set(["added", "contract-affecting"]);

interface DependencyContext {
  nodeId: string;
  signature: string;
  purpose: string | null;
}

interface GenerationTarget {
  node: DocNode;
  previous: DocNode | undefined;
  dependencyContext: DependencyContext[];
}

interface GeneratedNarrative {
  nodeId: string;
  rationale: string;
  example: string;
  gotchas: string[];
}

function buildDependencyContext(node: DocNode, allNodesById: Map<string, DocNode>): DependencyContext[] {
  // Section 9.2: inject only the contract facet of dependencies (signature
  // + one-line purpose), never their full bodies.
  return node.agentContract.dependencies
    .map((depId) => allNodesById.get(depId))
    .filter((n): n is DocNode => Boolean(n))
    .map((dep) => ({ nodeId: dep.nodeId, signature: dep.agentContract.signature, purpose: dep.humanNarrative.purpose }));
}

function formatEntityBlock(target: GenerationTarget): string {
  const { node, previous, dependencyContext } = target;
  const contract = node.agentContract;
  const depLines =
    dependencyContext.length > 0
      ? dependencyContext.map((d) => `  - ${d.nodeId}: ${d.signature}${d.purpose ? ` -- ${d.purpose}` : ""}`).join("\n")
      : "  (none)";

  // Section 9.3: patch existing narrative against the diff rather than
  // rewrite from scratch, when there's a previous version to patch.
  const priorSection = previous?.humanNarrative.rationale
    ? [
        "Existing narrative to patch (update it to fit the current contract; keep what's still accurate):",
        `  rationale: ${previous.humanNarrative.rationale}`,
        `  example: ${previous.humanNarrative.example ?? "(none)"}`,
        `  gotchas: ${previous.humanNarrative.gotchas.join("; ") || "(none)"}`,
      ].join("\n")
    : "No existing narrative -- write fresh.";

  return [
    `### ${node.nodeId}`,
    `Signature: ${contract.signature || "(none)"}`,
    `Purpose: ${node.humanNarrative.purpose ?? "(none)"}`,
    `Preconditions: ${contract.preconditions.join("; ") || "(none)"}`,
    `Postconditions: ${contract.postconditions.join("; ") || "(none)"}`,
    `Error modes: ${contract.errorModes.map((e) => `${e.errorType} when ${e.condition}`).join("; ") || "(none)"}`,
    "Dependencies (contract facet only, not full bodies):",
    depLines,
    priorSection,
  ].join("\n");
}

function buildNarrativePrompt(targets: GenerationTarget[]): string {
  const instructions =
    'For each entity below, write a short "rationale" (why it exists / when to use it, 1-2 sentences), ' +
    'a realistic "example" (a short usage snippet or description), and a "gotchas" array (0-3 short caveats, ' +
    'empty array if none). Respond with ONLY a JSON array, one object per entity, each shaped exactly as ' +
    '{"nodeId": string, "rationale": string, "example": string, "gotchas": string[]}. No prose outside the JSON.';
  return `${instructions}\n\n${targets.map(formatEntityBlock).join("\n\n")}`;
}

function parseJsonArrayResponse(text: string): unknown[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array in the model response");
  }
  return parsed;
}

function parseNarrativeResponse(text: string): GeneratedNarrative[] {
  return parseJsonArrayResponse(text).map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      nodeId: String(item.nodeId ?? ""),
      rationale: String(item.rationale ?? ""),
      example: String(item.example ?? ""),
      gotchas: Array.isArray(item.gotchas) ? item.gotchas.map(String) : [],
    };
  });
}

export interface NarrativeGenerationResult {
  nodes: DocNode[];
  generatedNodeIds: string[];
}

const NARRATIVE_CONFIDENCE_KEYS = ["humanNarrative.rationale", "humanNarrative.example", "humanNarrative.gotchas"] as const;

/**
 * Batches every node that actually needs new narrative into ONE model
 * call (Section 9.2: "batch related changed nodes from the same commit/PR
 * into one call") rather than one call per node. Nodes classified
 * "unchanged" already keep their narrative for free (scanRepo reuses the
 * same node object). Nodes classified "cosmetic" don't: their file WAS
 * re-extracted (the hash moved), and mechanical extraction always starts
 * narrative fields blank, so without this they'd silently lose previously
 * -generated content on every cosmetic edit -- explicitly carried forward
 * here instead.
 */
export async function generateNarratives(
  llm: LlmAdapter,
  currentNodes: DocNode[],
  previousGraph: DocGraph,
  changes: NodeChange[],
): Promise<NarrativeGenerationResult> {
  const previousById = new Map(previousGraph.nodes.map((n) => [n.nodeId, n]));
  const currentById = new Map(currentNodes.map((n) => [n.nodeId, n]));
  const classificationById = new Map(changes.map((c) => [c.nodeId, c.classification]));

  const targets: GenerationTarget[] = changes
    .filter((c) => NEEDS_GENERATION.has(c.classification))
    .map((c) => currentById.get(c.nodeId))
    .filter((n): n is DocNode => n !== undefined && n.entityType !== "module")
    .map((node) => ({
      node,
      previous: previousById.get(node.nodeId),
      dependencyContext: buildDependencyContext(node, currentById),
    }));

  const generatedById =
    targets.length > 0
      ? new Map(
          parseNarrativeResponse(
            (await llm.complete({ prompt: buildNarrativePrompt(targets), maxTokens: 400 * targets.length })).text,
          ).map((g) => [g.nodeId, g]),
        )
      : new Map<string, GeneratedNarrative>();

  const nodes = currentNodes.map((node) => {
    const generated = generatedById.get(node.nodeId);
    if (generated) {
      return {
        ...node,
        humanNarrative: {
          ...node.humanNarrative,
          rationale: generated.rationale,
          example: generated.example,
          gotchas: generated.gotchas,
        },
        confidence: {
          ...node.confidence,
          "humanNarrative.rationale": "inferred" as const,
          "humanNarrative.example": "inferred" as const,
          "humanNarrative.gotchas": "inferred" as const,
        },
      };
    }

    const previous = previousById.get(node.nodeId);
    if (classificationById.get(node.nodeId) === "cosmetic" && previous) {
      // Keep the freshly-extracted `purpose` (a cosmetic edit may be exactly
      // a reworded @purpose comment -- that IS the mechanical field, not
      // LLM output), but carry forward only the LLM-derived pieces.
      const carriedConfidence: Record<string, (typeof node.confidence)[string]> = {};
      for (const key of NARRATIVE_CONFIDENCE_KEYS) {
        const value = previous.confidence[key];
        if (value) carriedConfidence[key] = value;
      }
      return {
        ...node,
        humanNarrative: {
          ...node.humanNarrative,
          rationale: previous.humanNarrative.rationale,
          example: previous.humanNarrative.example,
          gotchas: previous.humanNarrative.gotchas,
        },
        confidence: { ...node.confidence, ...carriedConfidence },
      };
    }

    return node;
  });

  return { nodes, generatedNodeIds: [...generatedById.keys()] };
}

export interface ErrorResolutionResult {
  resolutions: Map<string, string>;
}

function buildResolutionPrompt(errorTypes: string[], errorContexts: Map<string, string[]>): string {
  const instructions =
    'For each error type below, write one short "resolution" sentence a developer could follow to fix or ' +
    'work around it. Respond with ONLY a JSON array of {"errorType": string, "resolution": string}. No prose outside the JSON.';
  const items = errorTypes
    .map((errorType) => `### ${errorType}\nThrown when: ${(errorContexts.get(errorType) ?? []).join("; ") || "(unknown)"}`)
    .join("\n\n");
  return `${instructions}\n\n${items}`;
}

function parseResolutionResponse(text: string): Map<string, string> {
  const entries = parseJsonArrayResponse(text).map((raw) => {
    const item = raw as Record<string, unknown>;
    return [String(item.errorType ?? ""), String(item.resolution ?? "")] as const;
  });
  return new Map(entries);
}

/** Batches every error type needing a fresh resolution into one model call, same batching rule as generateNarratives. */
export async function generateErrorResolutions(llm: LlmAdapter, errorTypes: string[], errorContexts: Map<string, string[]>): Promise<ErrorResolutionResult> {
  if (errorTypes.length === 0) {
    return { resolutions: new Map() };
  }
  const result = await llm.complete({ prompt: buildResolutionPrompt(errorTypes, errorContexts), maxTokens: 150 * errorTypes.length });
  return { resolutions: parseResolutionResponse(result.text) };
}
