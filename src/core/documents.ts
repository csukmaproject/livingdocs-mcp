/**
 * @purpose Dispatches a `generate <type>` request (from the CLI's `generate` command or the MCP server's generate_rollup tool) to the matching rollup generator, validating the type and writing the resulting document to disk.
 * @audience technical
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEdges } from "./doc-graph.js";
import { extractRepo } from "./extractor.js";
import { synthesizeBusinessRewrites, synthesizePrdRequirements } from "./cross-node-synthesis.js";
import {
  filterBusinessAudienceNodes,
  generateAgentContractReference,
  generateBusinessGuide,
  generateSrs,
  generateTechnicalGuide,
  renderPrd,
} from "./rollup-engine.js";
import { syncUserGuide, userGuidePath } from "./sync.js";
import type { LlmAdapter } from "./llm-adapter.js";
import type { ErrorTroubleshootingCrossCheck } from "./rollup-engine.js";
import type { DocGraph } from "./types.js";

/** docgen-plugin-plan.md Section 7's document-types table (User Guide excluded -- it has its own incremental sync in sync.ts). */
export const GENERATED_DOCUMENT_TYPES = ["agent-contract-reference", "srs", "prd", "technical-guide", "business-guide"] as const;
/**
 * @purpose Union of the document type strings that go through the mechanical rollup engine (excludes "user-guide", which has its own incremental sync).
 * @audience technical
 */
export type GeneratedDocumentType = (typeof GENERATED_DOCUMENT_TYPES)[number];
/**
 * @purpose Every document type generateDocument can produce: the rollup-engine types plus "user-guide".
 * @audience technical
 */
export type DocumentType = "user-guide" | GeneratedDocumentType;

const DOCUMENT_FILENAMES: Record<GeneratedDocumentType, string> = {
  "agent-contract-reference": "AGENT_CONTRACTS.md",
  srs: "SRS.md",
  prd: "PRD.md",
  "technical-guide": "TECHNICAL_GUIDE.md",
  "business-guide": "BUSINESS_GUIDE.md",
};

/**
 * @purpose Type guard checking whether an arbitrary type string is one of the known GeneratedDocumentType values, used to validate the `generate <type>` argument.
 * @contract pre: none.
 *   post: returns true and narrows to GeneratedDocumentType when type is a member of GENERATED_DOCUMENT_TYPES, false otherwise.
 *   side-effects: none.
 * @audience technical
 */
function isGeneratedDocumentType(type: string): type is GeneratedDocumentType {
  return (GENERATED_DOCUMENT_TYPES as readonly string[]).includes(type);
}

/**
 * @purpose Successful result shape of generateDocument: the generated content, where it's written, and an optional error/troubleshooting cross-check for the user-guide path.
 * @audience technical
 */
export interface GenerateDocumentSuccess {
  ok: true;
  documentType: DocumentType;
  outputPath: string;
  content: string;
  crossCheck?: ErrorTroubleshootingCrossCheck;
}

/**
 * @purpose Failure result shape of generateDocument, returned instead of throwing when the requested type is unknown or a required LLM adapter is missing.
 * @audience technical
 */
export interface GenerateDocumentFailure {
  ok: false;
  error: string;
}

/**
 * @purpose The discriminated-union return type of generateDocument, distinguished by the `ok` field.
 * @audience technical
 */
export type GenerateDocumentResult = GenerateDocumentSuccess | GenerateDocumentFailure;

/**
 * @purpose Single dispatch point for `generate <type>`, shared by the MCP server's generate_rollup tool and the CLI's `generate` command, so every entry point reuses the same rollup engine and doc graph.
 * @contract pre: repoRoot is the target repo's root path; type is the requested document type string.
 *   post: for "user-guide", delegates entirely to syncUserGuide's incremental sync and returns its content/crossCheck; for an unrecognized type, returns a failure result instead of throwing; for "prd" with no llm adapter, returns a failure result; otherwise re-extracts the repo into a fresh graph, dispatches to the matching rollup generator (synthesizing via LLM for "prd", optionally for "business-guide"), writes the result to <repoRoot>/<DOCUMENT_FILENAMES[type]>, and returns a success result with the content.
 *   throws: propagates any error thrown by extractRepo, the rollup generators, or writeFileSync (e.g. filesystem failures); known failure conditions (unknown type, missing llm for "prd") are returned as GenerateDocumentFailure rather than thrown.
 *   side-effects: re-extracts and reads the repo from disk for every type except "user-guide"; makes one batched LLM completion call for "prd" and, when an adapter is supplied, for "business-guide"; writes the generated document to disk for every type except "user-guide" (which writes via syncUserGuide internally).
 * @audience technical
 */
export async function generateDocument(repoRoot: string, type: string, llm: LlmAdapter | undefined): Promise<GenerateDocumentResult> {
  if (type === "user-guide") {
    const result = await syncUserGuide(repoRoot, { force: true, llm });
    return {
      ok: true,
      documentType: "user-guide",
      outputPath: userGuidePath(repoRoot),
      content: result.documentMarkdown,
      crossCheck: result.crossCheck,
    };
  }

  if (!isGeneratedDocumentType(type)) {
    return {
      ok: false,
      error: `Unknown document type "${type}". Known types: user-guide, ${GENERATED_DOCUMENT_TYPES.join(", ")}.`,
    };
  }

  const nodes = extractRepo(repoRoot);
  const graph: DocGraph = { nodes, edges: buildEdges(nodes) };
  const outputPath = join(repoRoot, DOCUMENT_FILENAMES[type]);

  let content: string;
  switch (type) {
    case "agent-contract-reference":
      content = generateAgentContractReference(graph);
      break;
    case "srs":
      content = generateSrs(graph);
      break;
    case "technical-guide":
      content = generateTechnicalGuide(graph);
      break;
    case "prd": {
      if (!llm) return { ok: false, error: "PRD generation needs cross-node synthesis -- no LLM adapter is available (no ANTHROPIC_API_KEY / no MCP host)." };
      content = renderPrd(await synthesizePrdRequirements(llm, graph));
      break;
    }
    case "business-guide": {
      const businessNodes = filterBusinessAudienceNodes(graph);
      const rewrites = llm ? await synthesizeBusinessRewrites(llm, businessNodes) : new Map();
      content = generateBusinessGuide(businessNodes, rewrites);
      break;
    }
  }

  writeFileSync(outputPath, `${content}\n`, "utf8");
  return { ok: true, documentType: type, outputPath, content };
}
