import { readFileSync } from "node:fs";
import { join } from "node:path";
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
