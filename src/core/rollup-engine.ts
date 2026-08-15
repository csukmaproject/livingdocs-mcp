/**
 * @purpose Renders the doc graph into human-facing document rollups (User Guide sections, Agent Contract Reference, SRS, Technical Guide, Business Guide, PRD) via pure, mechanical templating over already-extracted graph data.
 * @audience technical
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocGraph, DocNode } from "./types.js";

/**
 * @purpose Shape of the subset of package.json fields the rollup engine reads to render install/usage docs.
 * @audience technical
 */
export interface PackageMeta {
  name: string;
  description?: string;
  version?: string;
  bin?: Record<string, string> | string;
  scripts?: Record<string, string>;
}

/**
 * @purpose Loads and parses a repo's package.json so its metadata can feed the doc rollups.
 * @contract pre: repoRoot contains a readable, valid-JSON package.json.
 *   post: returns the parsed package.json as PackageMeta.
 *   throws: Error when the file does not exist or is unreadable.
 *   throws: SyntaxError when the file's contents are not valid JSON.
 *   side-effects: reads a file from disk.
 * @audience technical
 */
export function readPackageMeta(repoRoot: string): PackageMeta {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageMeta;
}

/**
 * @purpose Renders User Guide Section 2 (System Overview): package name/description, per-module purpose summaries, and a documented-entity count. Pure templating over already-extracted @purpose text and package metadata; zero LLM calls.
 * @contract pre: none.
 *   post: returns markdown text summarizing the graph's modules and package metadata.
 *   side-effects: none.
 * @audience technical
 */
export function generateSystemOverview(graph: DocGraph, pkg: PackageMeta): string {
  const lines: string[] = [];
  lines.push(`${pkg.name}${pkg.description ? ` — ${pkg.description}` : ""}`.trim());

  const moduleNodes = graph.nodes.filter((n) => n.entityType === "module" && n.humanNarrative.purpose);
  if (moduleNodes.length > 0) {
    lines.push("");
    lines.push("Modules:");
    for (const node of moduleNodes) {
      lines.push(`- \`${node.filePath}\` — ${node.humanNarrative.purpose}`);
    }
  }

  const entityCount = graph.nodes.filter((n) => n.entityType !== "module").length;
  const fileCount = new Set(graph.nodes.map((n) => n.filePath)).size;
  lines.push("");
  lines.push(`${entityCount} documented entit${entityCount === 1 ? "y" : "ies"} across ${fileCount} file(s).`);

  return lines.join("\n");
}

/**
 * @purpose Renders User Guide Section 3 (Getting Started): install command, bin entries, and npm scripts, sourced entirely from package.json. Zero LLM calls.
 * @contract pre: none.
 *   post: returns markdown text with an install snippet plus bin/script listings when present.
 *   side-effects: none.
 * @audience technical
 */
export function generateGettingStarted(pkg: PackageMeta): string {
  const lines: string[] = ["Install:", "", "```bash", `npm install ${pkg.name}`, "```"];

  const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin;
  if (bins && Object.keys(bins).length > 0) {
    lines.push("", "Available commands:");
    for (const name of Object.keys(bins)) {
      lines.push(`- \`${name}\``);
    }
  }

  if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
    lines.push("", "Available scripts:");
    for (const [name, command] of Object.entries(pkg.scripts)) {
      lines.push(`- \`npm run ${name}\` — ${command}`);
    }
  }

  return lines.join("\n");
}

/**
 * @purpose Loads the User Guide skeleton template shipped alongside this module. Resolved relative to this file (not process.cwd()) so it works the same whether running from /src (dev) or the built /dist (published package) -- tsup's onSuccess hook copies src/templates to dist/templates so the two stay siblings of core/ in both layouts.
 * @contract pre: templates/user-guide-template.md exists next to this module.
 *   post: returns the raw template file contents.
 *   throws: Error when the template file is missing or unreadable.
 *   side-effects: reads a file from disk.
 * @audience technical
 */
export function loadUserGuideTemplate(): string {
  const templatePath = fileURLToPath(new URL("../templates/user-guide-template.md", import.meta.url));
  return readFileSync(templatePath, "utf8");
}

/**
 * @purpose Produces the initial User Guide document for a project by substituting the project name into the template's placeholder tokens.
 * @contract pre: none.
 *   post: returns the template text with every `{{project_name}}` token replaced by pkg.name.
 *   side-effects: reads the template file from disk (via loadUserGuideTemplate).
 * @audience technical
 */
export function seedUserGuide(pkg: PackageMeta): string {
  return loadUserGuideTemplate().replace(/\{\{project_name\}\}/g, pkg.name);
}

const SECTION_MARKER_PREFIX = "<!-- livingdocs:section ";

/**
 * @purpose Locates a named section's heading line and the start of the next section within a rendered markdown document, using the `<!-- livingdocs:section KEY -->` marker convention.
 * @contract pre: none.
 *   post: returns the heading line index and the index where the next section marker begins (or the document's length when there is no next marker), or null when the marker is absent or not immediately followed by a heading line.
 *   side-effects: none.
 * @audience technical
 */
function findSectionBounds(
  lines: string[],
  sectionKey: string,
): { headingIndex: number; nextMarkerIndex: number } | null {
  const markerLine = `${SECTION_MARKER_PREFIX}${sectionKey} -->`;
  const markerIndex = lines.findIndex((line) => line.trim() === markerLine);
  if (markerIndex === -1) return null;
  const headingIndex = markerIndex + 1;
  if (!(lines[headingIndex]?.trim() ?? "").startsWith("#")) return null;
  let nextMarkerIndex = lines.findIndex((line, i) => i > headingIndex && line.trim().startsWith(SECTION_MARKER_PREFIX));
  if (nextMarkerIndex === -1) nextMarkerIndex = lines.length;
  return { headingIndex, nextMarkerIndex };
}

/**
 * @purpose Extracts a section's rendered body (the text between its heading and the next section marker) so callers can inspect current content, e.g. before deciding whether to regenerate it.
 * @contract pre: none.
 *   post: returns the trimmed body text between the section's heading and the next marker, or "" when the section marker is not found.
 *   side-effects: none.
 * @audience technical
 */
export function readSectionContent(documentMarkdown: string, sectionKey: string): string {
  const lines = documentMarkdown.split("\n");
  const bounds = findSectionBounds(lines, sectionKey);
  if (!bounds) return "";
  return lines
    .slice(bounds.headingIndex + 1, bounds.nextMarkerIndex)
    .join("\n")
    .trim();
}

/**
 * @purpose Rewrites a single named section's body in a rendered markdown document while leaving every other section and the heading itself untouched.
 * @contract pre: documentMarkdown contains a `<!-- livingdocs:section sectionKey -->` marker immediately followed by a heading line.
 *   post: returns the document with the section's body replaced by the trimmed content (or a single blank line when content is empty).
 *   throws: Error when no matching section marker is found in the document.
 *   side-effects: none.
 * @audience technical
 */
export function replaceSectionContent(documentMarkdown: string, sectionKey: string, content: string): string {
  const lines = documentMarkdown.split("\n");
  const bounds = findSectionBounds(lines, sectionKey);
  if (!bounds) {
    throw new Error(`No "${sectionKey}" section marker found in document.`);
  }
  const before = lines.slice(0, bounds.headingIndex + 1);
  const after = lines.slice(bounds.nextMarkerIndex);
  const body = content.trim().length > 0 ? ["", content.trim(), ""] : [""];
  return [...before, ...body, ...after].join("\n");
}

/**
 * @purpose Renders User Guide Section 4 (Core Features): one subsection per documented entity, combining the mechanically-extracted signature with whatever narrative (purpose/rationale/example/gotchas) has been generated so far by narrative-generator.ts.
 * @contract pre: none.
 *   post: returns markdown text, or a placeholder string when the graph has no non-module entities.
 *   side-effects: none.
 * @audience technical
 */
export function generateCoreFeatures(graph: DocGraph): string {
  const entityNodes = graph.nodes.filter((n) => n.entityType !== "module");
  if (entityNodes.length === 0) return "_No documented features yet._";

  return entityNodes
    .map((node) => {
      const lines = [`### ${node.entityName}`, "", "```", node.agentContract.signature, "```"];
      if (node.humanNarrative.purpose) lines.push("", node.humanNarrative.purpose);
      if (node.humanNarrative.rationale) lines.push("", node.humanNarrative.rationale);
      if (node.humanNarrative.example) lines.push("", "**Example:**", "", node.humanNarrative.example);
      if (node.humanNarrative.gotchas.length > 0) {
        lines.push("", "**Gotchas:**");
        for (const gotcha of node.humanNarrative.gotchas) lines.push(`- ${gotcha}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * @purpose Groups every distinct error type declared across the graph's nodes with the conditions under which each is thrown, for use as prompting context by the narrative generator.
 * @contract pre: none.
 *   post: returns a Map from errorType to the list of conditions (or a fallback "thrown by <entity>" string) collected across all nodes that declare it.
 *   side-effects: none.
 * @audience technical
 */
export function collectErrorContexts(graph: DocGraph): Map<string, string[]> {
  const contexts = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const errorMode of node.agentContract.errorModes) {
      const existing = contexts.get(errorMode.errorType) ?? [];
      existing.push(errorMode.condition || `thrown by ${node.entityName}`);
      contexts.set(errorMode.errorType, existing);
    }
  }
  return contexts;
}

const TROUBLESHOOTING_HEADER = "| Error | Thrown by | When | Suggested resolution |";
const TROUBLESHOOTING_SEPARATOR = "| --- | --- | --- | --- |";

/**
 * @purpose Renders User Guide Section 5 (Troubleshooting): one table row per distinct error type, cross-referencing which entities throw it, under what conditions, and its suggested resolution. `resolutions` maps errorType -> a suggested-fix sentence.
 * @contract pre: none.
 *   post: returns a markdown table, or a placeholder string when the graph declares no error modes. Rows with no resolution yet render with an explicit "_(not yet generated)_" placeholder rather than a blank cell, so a missing generation stays visible.
 *   side-effects: none.
 * @audience technical
 */
export function generateTroubleshooting(graph: DocGraph, resolutions: Map<string, string>): string {
  const throwers = new Map<string, Set<string>>();
  const conditions = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    for (const errorMode of node.agentContract.errorModes) {
      const throwerSet = throwers.get(errorMode.errorType) ?? new Set<string>();
      throwerSet.add(node.entityName);
      throwers.set(errorMode.errorType, throwerSet);
      const conditionSet = conditions.get(errorMode.errorType) ?? new Set<string>();
      if (errorMode.condition) conditionSet.add(errorMode.condition);
      conditions.set(errorMode.errorType, conditionSet);
    }
  }

  const errorTypes = [...throwers.keys()].sort();
  if (errorTypes.length === 0) return "_No known error modes yet._";

  const rows = errorTypes.map((errorType) => {
    const thrownBy = [...(throwers.get(errorType) ?? [])].join(", ");
    const when = [...(conditions.get(errorType) ?? [])].join("; ") || "(unspecified)";
    const resolution = resolutions.get(errorType) ?? "_(not yet generated)_";
    return `| ${errorType} | ${thrownBy} | ${when} | ${resolution} |`;
  });

  return [TROUBLESHOOTING_HEADER, TROUBLESHOOTING_SEPARATOR, ...rows].join("\n");
}

/**
 * @purpose Recovers the set of error types already listed in a rendered Troubleshooting table, by reading the first cell of each data row.
 * @contract pre: none.
 *   post: returns the set of distinct error-type strings found in the table's first column, skipping the header and separator rows.
 *   side-effects: none.
 * @audience technical
 */
function parseTroubleshootingErrorTypes(troubleshootingMarkdown: string): Set<string> {
  const errorTypes = new Set<string>();
  for (const line of troubleshootingMarkdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || trimmed === TROUBLESHOOTING_HEADER || trimmed === TROUBLESHOOTING_SEPARATOR) continue;
    const firstCell = trimmed.split("|")[1]?.trim();
    if (firstCell) errorTypes.add(firstCell);
  }
  return errorTypes;
}

/**
 * @purpose Result shape for crossCheckErrorsAndTroubleshooting: the error types present on one side but missing from the other.
 * @audience technical
 */
export interface ErrorTroubleshootingCrossCheck {
  missingFromTroubleshooting: string[];
  orphanedInTroubleshooting: string[];
}

/**
 * @purpose Detects drift between the error types declared in the doc graph and the rows actually present in a rendered Troubleshooting table (build brief Phase 8), since the two can fall out of sync across incremental regenerations (a node added without a following regen, a stale row left behind after code changed).
 * @contract pre: none.
 *   post: returns the error types declared in the graph but absent from the table, and the error types present in the table but no longer declared in the graph.
 *   side-effects: none.
 * @audience technical
 */
export function crossCheckErrorsAndTroubleshooting(graph: DocGraph, troubleshootingMarkdown: string): ErrorTroubleshootingCrossCheck {
  const errorTypesInGraph = new Set(graph.nodes.flatMap((n) => n.agentContract.errorModes.map((e) => e.errorType)));
  const errorTypesInTable = parseTroubleshootingErrorTypes(troubleshootingMarkdown);
  return {
    missingFromTroubleshooting: [...errorTypesInGraph].filter((e) => !errorTypesInTable.has(e)),
    orphanedInTroubleshooting: [...errorTypesInTable].filter((e) => !errorTypesInGraph.has(e)),
  };
}

// ---------------------------------------------------------------------------
// Phase 10: PRD / SRS / Technical Guide / Business Guide -- docgen-plugin
// -plan.md Section 7's document-types table, reusing this same rollup
// engine with different filters over the same doc graph, per Phase 10 of
// the build brief.
// ---------------------------------------------------------------------------

/**
 * @purpose Renders one entity's agent-contract facets (signature, preconditions, postconditions, side effects, error modes, dependencies) as a markdown block under a given heading, shared by the Agent Contract Reference and SRS rollups.
 * @contract pre: none.
 *   post: returns markdown text; any facet with no entries renders as "(none)" (or "none" for side effects) rather than an empty line.
 *   side-effects: none.
 * @audience technical
 */
function renderContractBlock(node: DocNode, heading: string): string {
  const c = node.agentContract;
  return [
    `### ${heading}`,
    "",
    "```",
    c.signature || "(no signature)",
    "```",
    "",
    `- **Preconditions:** ${c.preconditions.join("; ") || "(none)"}`,
    `- **Postconditions:** ${c.postconditions.join("; ") || "(none)"}`,
    `- **Side effects:** ${c.sideEffects.join("; ") || "none"}`,
    `- **Error modes:** ${c.errorModes.map((e) => `${e.errorType} when ${e.condition}`).join("; ") || "(none)"}`,
    `- **Dependencies:** ${c.dependencies.join(", ") || "(none)"}`,
  ].join("\n");
}

/**
 * @purpose Renders the Agent Contract Reference document: flat, structured agent-contract facets for every documented entity, keyed by nodeId. Mechanical, zero LLM.
 * @contract pre: none.
 *   post: returns markdown text, or a placeholder string when the graph has no non-module entities.
 *   side-effects: none.
 * @audience technical
 */
export function generateAgentContractReference(graph: DocGraph): string {
  const entityNodes = graph.nodes.filter((n) => n.entityType !== "module");
  if (entityNodes.length === 0) return "_No documented entities yet._";
  return entityNodes.map((node) => renderContractBlock(node, node.nodeId)).join("\n\n");
}

/**
 * @purpose Extracts a node's `requirement:*` tags, stripped of the `requirement:` prefix, for grouping entities by requirement in the SRS.
 * @contract pre: none.
 *   post: returns the list of requirement IDs found in node.tags (empty when none are present).
 *   side-effects: none.
 * @audience technical
 */
function requirementTagsOf(node: DocNode): string[] {
  return node.tags.filter((t) => t.startsWith("requirement:")).map((t) => t.slice("requirement:".length));
}

/**
 * @purpose Renders the SRS document: contract facets grouped by `@requirement` tag for traceability, with entities lacking any requirement tag collected into an "Unclassified" bucket. Mechanical, zero LLM.
 * @contract pre: none.
 *   post: returns markdown text with one section per requirement (sorted) plus an optional Unclassified section, or a placeholder string when the graph has no entities.
 *   side-effects: none.
 * @audience technical
 */
export function generateSrs(graph: DocGraph): string {
  const entityNodes = graph.nodes.filter((n) => n.entityType !== "module");
  const byRequirement = new Map<string, DocNode[]>();
  const unclassified: DocNode[] = [];

  for (const node of entityNodes) {
    const requirements = requirementTagsOf(node);
    if (requirements.length === 0) {
      unclassified.push(node);
      continue;
    }
    for (const requirement of requirements) {
      const list = byRequirement.get(requirement) ?? [];
      list.push(node);
      byRequirement.set(requirement, list);
    }
  }

  const sections = [...byRequirement.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([requirement, nodes]) => [`## ${requirement}`, ...nodes.map((n) => renderContractBlock(n, n.entityName))].join("\n\n"));

  if (unclassified.length > 0) {
    sections.push(["## Unclassified", ...unclassified.map((n) => renderContractBlock(n, n.entityName))].join("\n\n"));
  }

  return sections.length > 0 ? sections.join("\n\n") : "_No documented entities yet._";
}

/**
 * @purpose Renders the Technical Guide document: narrative facets grouped by source file/module, for a developer audience. Mechanical rollup of already-generated content; no fresh LLM calls of its own.
 * @contract pre: none.
 *   post: returns markdown text with one section per file (sorted by path), or a placeholder string when the graph has no nodes.
 *   side-effects: none.
 * @audience technical
 */
export function generateTechnicalGuide(graph: DocGraph): string {
  const byFile = new Map<string, DocNode[]>();
  for (const node of graph.nodes) {
    const list = byFile.get(node.filePath) ?? [];
    list.push(node);
    byFile.set(node.filePath, list);
  }
  if (byFile.size === 0) return "_No documented entities yet._";

  const sections = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, nodes]) => {
    const moduleNode = nodes.find((n) => n.entityType === "module");
    const entityNodesInFile = nodes.filter((n) => n.entityType !== "module");
    const lines = [`## ${filePath}`];
    if (moduleNode?.humanNarrative.purpose) lines.push("", moduleNode.humanNarrative.purpose);
    for (const node of entityNodesInFile) {
      lines.push("", `### ${node.entityName}`, "", "```", node.agentContract.signature || "(no signature)", "```");
      if (node.humanNarrative.purpose) lines.push("", node.humanNarrative.purpose);
      if (node.humanNarrative.rationale) lines.push("", node.humanNarrative.rationale);
    }
    return lines.join("\n");
  });

  return sections.join("\n\n");
}

/**
 * @purpose Selects the entities eligible for the Business Guide: non-module nodes explicitly tagged `audience:business` (build brief Phase 10 -- "same rollup [as Technical Guide], filtered to @audience:business").
 * @contract pre: none.
 *   post: returns the filtered list of DocNodes.
 *   side-effects: none.
 * @audience technical
 */
export function filterBusinessAudienceNodes(graph: DocGraph): DocNode[] {
  return graph.nodes.filter((n) => n.entityType !== "module" && n.tags.includes("audience:business"));
}

/**
 * @purpose Shape of an optional reading-level-adjusted rewrite of an entity's purpose/rationale, layered over its technical narrative for the Business Guide.
 * @audience technical
 */
export interface BusinessRewrite {
  purpose: string;
  rationale: string;
}

/**
 * @purpose Renders the Business Guide document: `audience:business`-tagged entities only, preferring a business-rewritten purpose/rationale over the technical narrative when one is available.
 * @contract pre: none.
 *   post: returns markdown text, or a placeholder string when businessNodes is empty.
 *   side-effects: none.
 * @audience technical
 */
export function generateBusinessGuide(businessNodes: DocNode[], rewrites: Map<string, BusinessRewrite>): string {
  if (businessNodes.length === 0) return "_No entities tagged `audience:business` yet._";
  return businessNodes
    .map((node) => {
      const rewrite = rewrites.get(node.nodeId);
      const lines = [`### ${node.entityName}`];
      const purpose = rewrite?.purpose || node.humanNarrative.purpose;
      const rationale = rewrite?.rationale || node.humanNarrative.rationale;
      if (purpose) lines.push("", purpose);
      if (rationale) lines.push("", rationale);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * @purpose Shape of a single synthesized PRD entry: one requirement's title, narrative description, and acceptance criteria.
 * @audience technical
 */
export interface PrdRequirement {
  requirementId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/**
 * @purpose Renders the PRD document: one entry per `@requirement` tag, synthesized across all entities that share it (Phase 10: "the one place real synthesis happens, since a requirement spans multiple entities").
 * @contract pre: none.
 *   post: returns markdown text, or a placeholder string when requirements is empty. Acceptance criteria render as a bullet list, or a "(none specified)" placeholder when empty.
 *   side-effects: none.
 * @audience technical
 */
export function renderPrd(requirements: PrdRequirement[]): string {
  if (requirements.length === 0) return "_No `@requirement`-tagged entities yet._";
  return requirements
    .map((r) =>
      [
        `## ${r.requirementId}: ${r.title}`,
        "",
        r.description,
        "",
        "**Acceptance criteria:**",
        ...(r.acceptanceCriteria.length > 0 ? r.acceptanceCriteria.map((c) => `- ${c}`) : ["- (none specified)"]),
      ].join("\n"),
    )
    .join("\n\n");
}
