import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocGraph } from "./types.js";

export interface PackageMeta {
  name: string;
  description?: string;
  version?: string;
  bin?: Record<string, string> | string;
  scripts?: Record<string, string>;
}

export function readPackageMeta(repoRoot: string): PackageMeta {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageMeta;
}

/**
 * User guide Section 2 (System Overview) — pure templating over already
 * -extracted @purpose text and package metadata. Zero LLM calls.
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
 * User guide Section 3 (Getting Started) — pure templating over
 * package.json (install command, bin entries, scripts). Zero LLM calls.
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
 * Loads the User Guide skeleton shipped alongside this module. Resolved
 * relative to this file (not process.cwd()) so it works the same whether
 * running from /src (dev) or the built /dist (published package) --
 * tsup's onSuccess hook copies src/templates to dist/templates so the two
 * stay siblings of core/ in both layouts.
 */
export function loadUserGuideTemplate(): string {
  const templatePath = fileURLToPath(new URL("../templates/user-guide-template.md", import.meta.url));
  return readFileSync(templatePath, "utf8");
}

export function seedUserGuide(pkg: PackageMeta): string {
  return loadUserGuideTemplate().replace(/\{\{project_name\}\}/g, pkg.name);
}

const SECTION_MARKER_PREFIX = "<!-- livingdocs:section ";

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

/** Reads a section's rendered body (between its heading and the next marker), trimmed. */
export function readSectionContent(documentMarkdown: string, sectionKey: string): string {
  const lines = documentMarkdown.split("\n");
  const bounds = findSectionBounds(lines, sectionKey);
  if (!bounds) return "";
  return lines
    .slice(bounds.headingIndex + 1, bounds.nextMarkerIndex)
    .join("\n")
    .trim();
}

/** Replaces a section's body content, leaving every other section and the heading itself untouched. */
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
 * User guide Section 4 (Core Features) -- one subsection per documented
 * entity. Signature/purpose/error-modes are extracted (mechanical);
 * rationale/example/gotchas are filled in by narrative-generator.ts when
 * an LLM adapter is available, and left blank otherwise.
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

/** Every distinct error type declared across the graph's nodes, each with the conditions that throw it (for prompting/context). */
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
 * User guide Section 5 (Troubleshooting) -- one row per distinct error
 * type. `resolutions` maps errorType -> a suggested-fix sentence; entries
 * with no resolution yet render with a placeholder rather than a blank
 * cell, so a missing generation is visible instead of silently blank.
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

export interface ErrorTroubleshootingCrossCheck {
  missingFromTroubleshooting: string[];
  orphanedInTroubleshooting: string[];
}

/**
 * Section 4<->5 cross-check (build brief Phase 8): every custom error type
 * declared in the graph should have a matching troubleshooting row, and
 * vice versa. Flags mismatches instead of silently dropping either side --
 * these can drift apart across incremental regenerations (a node added
 * without a following regen, a stale row left behind after code changed).
 */
export function crossCheckErrorsAndTroubleshooting(graph: DocGraph, troubleshootingMarkdown: string): ErrorTroubleshootingCrossCheck {
  const errorTypesInGraph = new Set(graph.nodes.flatMap((n) => n.agentContract.errorModes.map((e) => e.errorType)));
  const errorTypesInTable = parseTroubleshootingErrorTypes(troubleshootingMarkdown);
  return {
    missingFromTroubleshooting: [...errorTypesInGraph].filter((e) => !errorTypesInTable.has(e)),
    orphanedInTroubleshooting: [...errorTypesInTable].filter((e) => !errorTypesInGraph.has(e)),
  };
}
