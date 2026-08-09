import { parseJsonArrayResponse } from "./narrative-generator.js";
import type { LlmAdapter } from "./llm-adapter.js";
import type { BusinessRewrite, PrdRequirement } from "./rollup-engine.js";
import type { DocGraph, DocNode } from "./types.js";

function requirementTagsOf(node: DocNode): string[] {
  return node.tags.filter((t) => t.startsWith("requirement:")).map((t) => t.slice("requirement:".length));
}

function groupByRequirement(graph: DocGraph): Map<string, DocNode[]> {
  const groups = new Map<string, DocNode[]>();
  for (const node of graph.nodes) {
    if (node.entityType === "module") continue;
    for (const requirementId of requirementTagsOf(node)) {
      const list = groups.get(requirementId) ?? [];
      list.push(node);
      groups.set(requirementId, list);
    }
  }
  return groups;
}

function formatRequirementBlock(requirementId: string, nodes: DocNode[]): string {
  const entityLines = nodes.map((n) => {
    const c = n.agentContract;
    return `  - ${n.entityName} (${n.filePath}): ${n.humanNarrative.purpose ?? "(no purpose recorded)"} | pre: ${c.preconditions.join("; ") || "none"} | post: ${c.postconditions.join("; ") || "none"}`;
  });
  return `### ${requirementId}\nEntities implementing this requirement:\n${entityLines.join("\n")}`;
}

function buildPrdPrompt(requirementGroups: Map<string, DocNode[]>): string {
  const instructions =
    "For each requirement below, synthesize a PRD entry from the entities that implement it -- a requirement can span " +
    "multiple entities, so describe the REQUIREMENT itself, not any one entity. Respond with ONLY a JSON array, one " +
    'object per requirement, shaped exactly as {"requirementId": string, "title": string, "description": string, ' +
    '"acceptanceCriteria": string[]}. "requirementId" must be exactly the "### <id>" heading text. No prose outside the JSON.';
  const blocks = [...requirementGroups.entries()].map(([id, nodes]) => formatRequirementBlock(id, nodes));
  return `${instructions}\n\n${blocks.join("\n\n")}`;
}

function parsePrdResponse(text: string): PrdRequirement[] {
  return parseJsonArrayResponse(text).map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      requirementId: String(item.requirementId ?? ""),
      title: String(item.title ?? ""),
      description: String(item.description ?? ""),
      acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.map(String) : [],
    };
  });
}

/**
 * PRD needs genuine cross-node synthesis -- a requirement spans multiple
 * entities (build brief Phase 10). Scoped to ONLY the @requirement-tagged
 * nodes, never the full graph, and batched into one call.
 */
export async function synthesizePrdRequirements(llm: LlmAdapter, graph: DocGraph): Promise<PrdRequirement[]> {
  const groups = groupByRequirement(graph);
  if (groups.size === 0) return [];
  const response = await llm.complete({ prompt: buildPrdPrompt(groups), maxTokens: 400 * groups.size });
  return parsePrdResponse(response.text);
}

function formatBusinessBlock(node: DocNode): string {
  return `### ${node.nodeId}\nTechnical purpose: ${node.humanNarrative.purpose ?? "(none)"}\nTechnical rationale: ${node.humanNarrative.rationale ?? "(none)"}`;
}

function buildBusinessRewritePrompt(nodes: DocNode[]): string {
  const instructions =
    "Rewrite each entity's purpose and rationale for a NON-TECHNICAL business stakeholder: no jargon, no implementation " +
    'detail, focus on what it accomplishes for the business/user. Respond with ONLY a JSON array, one object per entity, ' +
    'shaped exactly as {"nodeId": string, "purpose": string, "rationale": string}. No prose outside the JSON.';
  return `${instructions}\n\n${nodes.map(formatBusinessBlock).join("\n\n")}`;
}

function parseBusinessResponse(text: string): Array<{ nodeId: string } & BusinessRewrite> {
  return parseJsonArrayResponse(text).map((raw) => {
    const item = raw as Record<string, unknown>;
    return { nodeId: String(item.nodeId ?? ""), purpose: String(item.purpose ?? ""), rationale: String(item.rationale ?? "") };
  });
}

/** Business Guide's "reading level adjusted" rewrite (build brief Phase 10). Batched, scoped to only the @audience:business nodes passed in. */
export async function synthesizeBusinessRewrites(llm: LlmAdapter, businessNodes: DocNode[]): Promise<Map<string, BusinessRewrite>> {
  if (businessNodes.length === 0) return new Map();
  const response = await llm.complete({ prompt: buildBusinessRewritePrompt(businessNodes), maxTokens: 300 * businessNodes.length });
  return new Map(parseBusinessResponse(response.text).map(({ nodeId, ...rewrite }) => [nodeId, rewrite]));
}
