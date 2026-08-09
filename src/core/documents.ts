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
export type GeneratedDocumentType = (typeof GENERATED_DOCUMENT_TYPES)[number];
export type DocumentType = "user-guide" | GeneratedDocumentType;

const DOCUMENT_FILENAMES: Record<GeneratedDocumentType, string> = {
  "agent-contract-reference": "AGENT_CONTRACTS.md",
  srs: "SRS.md",
  prd: "PRD.md",
  "technical-guide": "TECHNICAL_GUIDE.md",
  "business-guide": "BUSINESS_GUIDE.md",
};

function isGeneratedDocumentType(type: string): type is GeneratedDocumentType {
  return (GENERATED_DOCUMENT_TYPES as readonly string[]).includes(type);
}

export interface GenerateDocumentSuccess {
  ok: true;
  documentType: DocumentType;
  outputPath: string;
  content: string;
  crossCheck?: ErrorTroubleshootingCrossCheck;
}

export interface GenerateDocumentFailure {
  ok: false;
  error: string;
}

export type GenerateDocumentResult = GenerateDocumentSuccess | GenerateDocumentFailure;

/**
 * Single dispatch point for `generate <type>` (build brief Phase 10),
 * shared by the MCP server's generate_rollup tool and the CLI's `generate`
 * command. Reuses the same rollup engine and doc graph as everything else
 * -- only the filter/synthesis per type differs, per docgen-plugin-plan.md
 * Section 7.
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
