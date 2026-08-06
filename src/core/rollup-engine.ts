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
