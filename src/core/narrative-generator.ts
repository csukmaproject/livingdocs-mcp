/**
 * @purpose Generates LLM-authored narrative text (rationale, example, gotchas) for doc-graph nodes whose contract changed or that are new, and LLM-authored resolution text for error types, batching each need into a single completion call.
 * @audience technical
 */
import type { NodeChange, ChangeClassification } from "./ast-diff.js";
import type { LlmAdapter } from "./llm-adapter.js";
import type { DocGraph, DocNode } from "./types.js";

// Section 9.1 of docgen-plugin-plan.md: only contract-affecting changes
// (and brand-new nodes) proceed to the model. Cosmetic edits keep their
// previously-generated narrative untouched.
const NEEDS_GENERATION: ReadonlySet<ChangeClassification> = new Set(["added", "contract-affecting"]);

/**
 * @purpose Carries only the contract facet (id, signature, one-line purpose) of a node's dependency into the narrative prompt, never the dependency's full body.
 * @audience technical
 */
interface DependencyContext {
  nodeId: string;
  signature: string;
  purpose: string | null;
}

/**
 * @purpose Bundles a node that needs fresh narrative with its previous version (to patch against) and its resolved dependency context, ready to format into a prompt entry.
 * @audience technical
 */
interface GenerationTarget {
  node: DocNode;
  previous: DocNode | undefined;
  dependencyContext: DependencyContext[];
}

/**
 * @purpose Shape of one parsed narrative item returned by the model for a single node (rationale, example, gotchas).
 * @audience technical
 */
interface GeneratedNarrative {
  nodeId: string;
  rationale: string;
  example: string;
  gotchas: string[];
}

/**
 * @purpose Resolves a node's declared dependency ids into their contract-facet-only DependencyContext, so the narrative prompt never sees a dependency's full body.
 * @contract pre: allNodesById should be keyed by the current extraction's node ids.
 *   post: returns one DependencyContext per dependency id that resolves in allNodesById; unresolved ids are silently dropped.
 *   side-effects: none.
 * @audience technical
 */
function buildDependencyContext(node: DocNode, allNodesById: Map<string, DocNode>): DependencyContext[] {
  // Section 9.2: inject only the contract facet of dependencies (signature
  // + one-line purpose), never their full bodies.
  return node.agentContract.dependencies
    .map((depId) => allNodesById.get(depId))
    .filter((n): n is DocNode => Boolean(n))
    .map((dep) => ({ nodeId: dep.nodeId, signature: dep.agentContract.signature, purpose: dep.humanNarrative.purpose }));
}

/**
 * @purpose Renders a single GenerationTarget into the prompt text block (signature, contract, dependencies, and prior narrative if any) that the model sees for that entity.
 * @contract pre: none.
 *   post: returns a multi-line string block for one entity, ending with either the existing narrative to patch or "No existing narrative -- write fresh."
 *   side-effects: none.
 * @audience technical
 */
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

/**
 * @purpose Assembles the full batched prompt sent to the model: fixed instructions plus one formatted block per generation target.
 * @contract pre: none.
 *   post: returns the complete prompt string for the batch.
 *   side-effects: none.
 * @audience technical
 */
function buildNarrativePrompt(targets: GenerationTarget[]): string {
  const instructions =
    'For each entity below, write a short "rationale" (why it exists / when to use it, 1-2 sentences), ' +
    'a realistic "example" (a short usage snippet or description), and a "gotchas" array (0-3 short caveats, ' +
    'empty array if none). Respond with ONLY a JSON array, one object per entity, each shaped exactly as ' +
    '{"nodeId": string, "rationale": string, "example": string, "gotchas": string[]}. No prose outside the JSON.';
  return `${instructions}\n\n${targets.map(formatEntityBlock).join("\n\n")}`;
}

/**
 * @purpose Strips an optional ```json code fence from a raw model completion and parses the remainder as JSON, shared by every prompt parser in this module and cross-node-synthesis.ts.
 * @contract pre: text is the raw text of a model completion.
 *   post: returns the parsed JSON value as an array.
 *   throws: SyntaxError when the cleaned text is not valid JSON.
 *   throws: Error when the parsed JSON is valid but not an array.
 *   side-effects: none.
 * @audience technical
 */
export function parseJsonArrayResponse(text: string): unknown[] {
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

/**
 * @purpose Parses the model's raw completion text for a narrative-generation batch into typed GeneratedNarrative records.
 * @contract pre: text is expected to be the JSON array produced from a buildNarrativePrompt call.
 *   post: returns one GeneratedNarrative per array item, coercing missing/wrong-typed fields to "" or [].
 *   throws: propagates whatever parseJsonArrayResponse throws for malformed or non-array JSON.
 *   side-effects: none.
 * @audience technical
 */
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

/**
 * @purpose Return shape of generateNarratives: the full updated node list plus the ids of nodes that actually got a fresh model-generated narrative.
 * @audience technical
 */
export interface NarrativeGenerationResult {
  nodes: DocNode[];
  generatedNodeIds: string[];
}

const NARRATIVE_CONFIDENCE_KEYS = ["humanNarrative.rationale", "humanNarrative.example", "humanNarrative.gotchas"] as const;

/**
 * @purpose Batches every node that actually needs new narrative into ONE model call rather than one call per node, and carries forward previously-generated narrative for nodes whose file changed only cosmetically.
 * @contract pre: currentNodes, previousGraph, and changes should all describe the same repo scan (matching nodeIds).
 *   post: returns every current node, where nodes classified "added" or "contract-affecting" get fresh model-generated rationale/example/gotchas (confidence marked "inferred"), nodes classified "cosmetic" with a matching previous node have their narrative fields carried forward unchanged from previousGraph, and all other nodes pass through as-is; also returns the ids of nodes that got fresh narrative.
 *   throws: propagates whatever parseNarrativeResponse/parseJsonArrayResponse throws if the model's response is not a parseable JSON array.
 *   side-effects: makes one batched LLM completion call via the provided adapter when at least one node needs generation; makes no call otherwise.
 * @audience technical
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

/**
 * @purpose Return shape of generateErrorResolutions: a map from error type name to its model-authored resolution sentence.
 * @audience technical
 */
export interface ErrorResolutionResult {
  resolutions: Map<string, string>;
}

/**
 * @purpose Assembles the batched prompt asking the model for one resolution sentence per distinct error type, including the contexts where each error is thrown.
 * @contract pre: none.
 *   post: returns the complete prompt string for the batch.
 *   side-effects: none.
 * @audience technical
 */
function buildResolutionPrompt(errorTypes: string[], errorContexts: Map<string, string[]>): string {
  const instructions =
    'For each error type below, write one short "resolution" sentence a developer could follow to fix or ' +
    'work around it. Respond with ONLY a JSON array of {"errorType": string, "resolution": string}. No prose outside the JSON.';
  const items = errorTypes
    .map((errorType) => `### ${errorType}\nThrown when: ${(errorContexts.get(errorType) ?? []).join("; ") || "(unknown)"}`)
    .join("\n\n");
  return `${instructions}\n\n${items}`;
}

/**
 * @purpose Parses the model's raw completion text for an error-resolution batch into an errorType-to-resolution map.
 * @contract pre: text is expected to be the JSON array produced from a buildResolutionPrompt call.
 *   post: returns a Map from errorType to resolution string, coercing missing fields to "".
 *   throws: propagates whatever parseJsonArrayResponse throws for malformed or non-array JSON.
 *   side-effects: none.
 * @audience technical
 */
function parseResolutionResponse(text: string): Map<string, string> {
  const entries = parseJsonArrayResponse(text).map((raw) => {
    const item = raw as Record<string, unknown>;
    return [String(item.errorType ?? ""), String(item.resolution ?? "")] as const;
  });
  return new Map(entries);
}

/**
 * @purpose Batches every error type needing a fresh resolution into one model call, same batching rule as generateNarratives.
 * @contract pre: none.
 *   post: returns an empty resolutions map when errorTypes is empty; otherwise returns one resolution string per errorType from the model's response.
 *   throws: propagates whatever parseResolutionResponse/parseJsonArrayResponse throws if the model's response is not a parseable JSON array.
 *   side-effects: makes one batched LLM completion call via the provided adapter when errorTypes is non-empty; makes no call otherwise.
 * @audience technical
 */
export async function generateErrorResolutions(llm: LlmAdapter, errorTypes: string[], errorContexts: Map<string, string[]>): Promise<ErrorResolutionResult> {
  if (errorTypes.length === 0) {
    return { resolutions: new Map() };
  }
  const result = await llm.complete({ prompt: buildResolutionPrompt(errorTypes, errorContexts), maxTokens: 150 * errorTypes.length });
  return { resolutions: parseResolutionResponse(result.text) };
}
