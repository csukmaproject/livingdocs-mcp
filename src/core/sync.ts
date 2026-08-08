import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEdges, loadGraph, saveGraph } from "./doc-graph.js";
import { getCurrentCommit } from "./git.js";
import { scanRepo } from "./incremental-extract.js";
import {
  generateGettingStarted,
  generateSystemOverview,
  readPackageMeta,
  readSectionContent,
  replaceSectionContent,
  seedUserGuide,
} from "./rollup-engine.js";
import { applyRegeneration } from "./revision-writer.js";
import type { NodeChange } from "./ast-diff.js";
import type { DocGraph, DocNode } from "./types.js";

export const USER_GUIDE_FILENAME = "USER_GUIDE.md";

export function userGuidePath(repoRoot: string): string {
  return join(repoRoot, USER_GUIDE_FILENAME);
}

export function readUserGuide(repoRoot: string): string {
  const path = userGuidePath(repoRoot);
  if (existsSync(path)) return readFileSync(path, "utf8");
  return seedUserGuide(readPackageMeta(repoRoot));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** undefined (not the sentinel) when there's no real commit to diff against next time. */
function resolveScannedCommit(repoRoot: string): string | undefined {
  const commit = getCurrentCommit(repoRoot);
  return commit === "working-tree" ? undefined : commit;
}

export interface SyncOptions {
  /** Force-regenerate both sections' text even if nothing changed underneath (generate_rollup / `generate user-guide`). */
  force?: boolean;
}

export interface SyncResult {
  currentNodes: DocNode[];
  changes: NodeChange[];
  sectionsChanged: string[];
  revisionRowAdded: boolean;
  documentMarkdown: string;
}

/**
 * Reads, recomputes, and writes the user guide + graph in one place --
 * shared by the MCP server's update_doc/generate_rollup tools and the
 * CLI's update/generate commands (docs/build brief Phase 5: "CLI uses the
 * same core as the MCP server"), so the two surfaces can't drift the way
 * scanRepo's git-scoping once did between them.
 */
export function syncUserGuide(repoRoot: string, options: SyncOptions = {}): SyncResult {
  const previousGraph = loadGraph(repoRoot);
  const { currentNodes, changes } = scanRepo(repoRoot, previousGraph);
  const pkg = readPackageMeta(repoRoot);
  const document = readUserGuide(repoRoot);
  const currentGraph: DocGraph = { nodes: currentNodes, edges: buildEdges(currentNodes) };

  const newSystemOverview = generateSystemOverview(currentGraph, pkg);
  const newGettingStarted = generateGettingStarted(pkg);

  let updatedDocument = document;
  const sectionsChanged: string[] = [];
  if (options.force || newSystemOverview !== readSectionContent(document, "system-overview")) {
    updatedDocument = replaceSectionContent(updatedDocument, "system-overview", newSystemOverview);
    sectionsChanged.push("system-overview");
  }
  if (options.force || newGettingStarted !== readSectionContent(document, "getting-started")) {
    updatedDocument = replaceSectionContent(updatedDocument, "getting-started", newGettingStarted);
    sectionsChanged.push("getting-started");
  }

  const date = today();
  const regeneration = applyRegeneration(previousGraph, currentNodes, changes, updatedDocument, getCurrentCommit(repoRoot), date);

  const sectionSyncDates = { ...previousGraph.sectionSyncDates };
  for (const key of sectionsChanged) sectionSyncDates[key] = date;

  saveGraph(repoRoot, {
    nodes: regeneration.nodes,
    edges: buildEdges(regeneration.nodes),
    lastScannedCommit: resolveScannedCommit(repoRoot),
    sectionSyncDates,
  });
  writeFileSync(userGuidePath(repoRoot), regeneration.documentMarkdown, "utf8");

  return {
    currentNodes: regeneration.nodes,
    changes,
    sectionsChanged,
    revisionRowAdded: regeneration.addedRevisionRow,
    documentMarkdown: regeneration.documentMarkdown,
  };
}
