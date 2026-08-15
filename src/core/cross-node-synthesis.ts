/**
 * @purpose Performs cross-node LLM synthesis that a single-node narrative pass cannot: grouping @requirement-tagged nodes into PRD requirement entries, and rewriting business-audience nodes' purpose/rationale for non-technical readers.
 * @audience technical
 */
import { parseJsonArrayResponse } from "./narrative-generator.js";
import type { LlmAdapter } from "./llm-adapter.js";
import type { BusinessRewrite, PrdRequirement } from "./rollup-engine.js";
import type { DocGraph, DocNode } from "./types.js";

/**
 * @purpose Extracts the requirement ids a node is tagged with, from its raw "requirement:<id>" tag strings.
 * @contract pre: none.
 *   post: returns the requirement id portion of every tag on the node that starts with "requirement:"; empty array if none.
 *   side-effects: none.
 * @audience technical
 */
function requirementTagsOf(node: DocNode): string[] {
  return node.tags.filter((t) => t.startsWith("requirement:")).map((t) => t.slice("requirement:".length));
}

/**
 * @purpose Groups every non-module node in the graph by the requirement id(s) it is tagged with, so a requirement spanning multiple entities can be synthesized as one PRD entry.
 * @contract pre: none.
 *   post: returns a map from requirement id to the list of nodes tagged with it; module nodes are excluded, and untagged nodes are simply absent from any group.
 *   side-effects: none.
 * @audience technical
 */
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

/**
 * @purpose Renders one requirement's implementing entities (name, file, purpose, pre/post-conditions) into the prompt text block for that requirement.
 * @contract pre: none.
 *   post: returns a "### <requirementId>" heading followed by one summary line per entity.
 *   side-effects: none.
 * @audience technical
 */
function formatRequirementBlock(requirementId: string, nodes: DocNode[]): string {
  const entityLines = nodes.map((n) => {
    const c = n.agentContract;
    return `  - ${n.entityName} (${n.filePath}): ${n.humanNarrative.purpose ?? "(no purpose recorded)"} | pre: ${c.preconditions.join("; ") || "none"} | post: ${c.postconditions.join("; ") || "none"}`;
  });
  return `### ${requirementId}\nEntities implementing this requirement:\n${entityLines.join("\n")}`;
}

/**
 * @purpose Assembles the full batched prompt asking the model to synthesize one PRD entry per requirement group.
 * @contract pre: none.
 *   post: returns the complete prompt string, with each requirement's "### <id>" heading matching what parsePrdResponse expects back as requirementId.
 *   side-effects: none.
 * @audience technical
 */
function buildPrdPrompt(requirementGroups: Map<string, DocNode[]>): string {
  const instructions =
    "For each requirement below, synthesize a PRD entry from the entities that implement it -- a requirement can span " +
    "multiple entities, so describe the REQUIREMENT itself, not any one entity. Respond with ONLY a JSON array, one " +
    'object per requirement, shaped exactly as {"requirementId": string, "title": string, "description": string, ' +
    '"acceptanceCriteria": string[]}. "requirementId" must be exactly the "### <id>" heading text. No prose outside the JSON.';
  const blocks = [...requirementGroups.entries()].map(([id, nodes]) => formatRequirementBlock(id, nodes));
  return `${instructions}\n\n${blocks.join("\n\n")}`;
}

/**
 * @purpose Parses the model's raw completion text for a PRD-synthesis batch into typed PrdRequirement records.
 * @contract pre: text is expected to be the JSON array produced from a buildPrdPrompt call.
 *   post: returns one PrdRequirement per array item, coercing missing/wrong-typed fields to "" or [].
 *   throws: propagates whatever parseJsonArrayResponse throws for malformed or non-array JSON.
 *   side-effects: none.
 * @audience technical
 */
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
 * @purpose PRD needs genuine cross-node synthesis -- a requirement spans multiple entities -- so this synthesizes one PRD entry per requirement id from only its @requirement-tagged nodes, scoped away from the full graph and batched into one call.
 * @contract pre: none.
 *   post: returns an empty array when no node in the graph carries a requirement tag; otherwise returns one PrdRequirement per distinct requirement id found.
 *   throws: propagates whatever parsePrdResponse/parseJsonArrayResponse throws if the model's response is not a parseable JSON array.
 *   side-effects: makes one batched LLM completion call via the provided adapter when at least one requirement-tagged node exists; makes no call otherwise.
 * @audience technical
 */
export async function synthesizePrdRequirements(llm: LlmAdapter, graph: DocGraph): Promise<PrdRequirement[]> {
  const groups = groupByRequirement(graph);
  if (groups.size === 0) return [];
  const response = await llm.complete({ prompt: buildPrdPrompt(groups), maxTokens: 400 * groups.size });
  return parsePrdResponse(response.text);
}

/**
 * @purpose Renders one node's technical purpose and rationale into the prompt text block the model rewrites for a business audience.
 * @contract pre: none.
 *   post: returns a "### <nodeId>" heading followed by the node's current technical purpose and rationale.
 *   side-effects: none.
 * @audience technical
 */
function formatBusinessBlock(node: DocNode): string {
  return `### ${node.nodeId}\nTechnical purpose: ${node.humanNarrative.purpose ?? "(none)"}\nTechnical rationale: ${node.humanNarrative.rationale ?? "(none)"}`;
}

/**
 * @purpose Assembles the full batched prompt asking the model to rewrite each business-audience node's purpose and rationale for a non-technical reader.
 * @contract pre: none.
 *   post: returns the complete prompt string for the batch.
 *   side-effects: none.
 * @audience technical
 */
function buildBusinessRewritePrompt(nodes: DocNode[]): string {
  const instructions =
    "Rewrite each entity's purpose and rationale for a NON-TECHNICAL business stakeholder: no jargon, no implementation " +
    'detail, focus on what it accomplishes for the business/user. Respond with ONLY a JSON array, one object per entity, ' +
    'shaped exactly as {"nodeId": string, "purpose": string, "rationale": string}. No prose outside the JSON.';
  return `${instructions}\n\n${nodes.map(formatBusinessBlock).join("\n\n")}`;
}

/**
 * @purpose Parses the model's raw completion text for a business-rewrite batch into typed nodeId+BusinessRewrite records.
 * @contract pre: text is expected to be the JSON array produced from a buildBusinessRewritePrompt call.
 *   post: returns one {nodeId, purpose, rationale} per array item, coercing missing fields to "".
 *   throws: propagates whatever parseJsonArrayResponse throws for malformed or non-array JSON.
 *   side-effects: none.
 * @audience technical
 */
function parseBusinessResponse(text: string): Array<{ nodeId: string } & BusinessRewrite> {
  return parseJsonArrayResponse(text).map((raw) => {
    const item = raw as Record<string, unknown>;
    return { nodeId: String(item.nodeId ?? ""), purpose: String(item.purpose ?? ""), rationale: String(item.rationale ?? "") };
  });
}

/**
 * @purpose Business Guide's "reading level adjusted" rewrite: batches every passed-in @audience:business node into one model call that rewrites its purpose and rationale for a non-technical stakeholder.
 * @contract pre: businessNodes should already be scoped to only @audience:business nodes by the caller.
 *   post: returns an empty map when businessNodes is empty; otherwise returns one BusinessRewrite per node, keyed by nodeId.
 *   throws: propagates whatever parseBusinessResponse/parseJsonArrayResponse throws if the model's response is not a parseable JSON array.
 *   side-effects: makes one batched LLM completion call via the provided adapter when businessNodes is non-empty; makes no call otherwise.
 * @audience technical
 */
export async function synthesizeBusinessRewrites(llm: LlmAdapter, businessNodes: DocNode[]): Promise<Map<string, BusinessRewrite>> {
  if (businessNodes.length === 0) return new Map();
  const response = await llm.complete({ prompt: buildBusinessRewritePrompt(businessNodes), maxTokens: 300 * businessNodes.length });
  return new Map(parseBusinessResponse(response.text).map(({ nodeId, ...rewrite }) => [nodeId, rewrite]));
}
