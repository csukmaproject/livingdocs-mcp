/**
 * @purpose Shared read-recompute-write cycle for the user guide and doc graph, used by both the MCP server's tools and the CLI's commands so the two surfaces can't drift apart.
 * @audience technical
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEdges, loadGraph, saveGraph } from "./doc-graph.js";
import { getCurrentCommit } from "./git.js";
import { scanRepo } from "./incremental-extract.js";
import type { LlmAdapter } from "./llm-adapter.js";
import { generateErrorResolutions, generateNarratives } from "./narrative-generator.js";
import {
  collectErrorContexts,
  crossCheckErrorsAndTroubleshooting,
  generateCoreFeatures,
  generateGettingStarted,
  generateSystemOverview,
  generateTroubleshooting,
  readPackageMeta,
  readSectionContent,
  replaceSectionContent,
  seedUserGuide,
  type ErrorTroubleshootingCrossCheck,
} from "./rollup-engine.js";
import { applyRegeneration } from "./revision-writer.js";
import type { NodeChange } from "./ast-diff.js";
import type { DocGraph, DocNode } from "./types.js";

export const USER_GUIDE_FILENAME = "USER_GUIDE.md";

/**
 * @purpose Builds the absolute path to the repo's USER_GUIDE.md file.
 * @contract pre: repoRoot is an absolute path to the repo root.
 *   post: returns repoRoot joined with USER_GUIDE_FILENAME.
 *   side-effects: none.
 * @audience technical
 */
export function userGuidePath(repoRoot: string): string {
  return join(repoRoot, USER_GUIDE_FILENAME);
}

/**
 * @purpose Reads the existing USER_GUIDE.md, or seeds a fresh one from package metadata if it doesn't exist yet.
 * @contract post: returns the file's contents when USER_GUIDE.md exists, else a freshly seeded document built from package.json metadata.
 *   side-effects: reads the filesystem (existsSync/readFileSync); no writes.
 * @audience technical
 */
export function readUserGuide(repoRoot: string): string {
  const path = userGuidePath(repoRoot);
  if (existsSync(path)) return readFileSync(path, "utf8");
  return seedUserGuide(readPackageMeta(repoRoot));
}

/**
 * @purpose Returns today's date as the date stamp used on revision rows/entries during a sync.
 * @contract post: returns the current date in ISO date-only format (YYYY-MM-DD).
 *   side-effects: none.
 * @audience technical
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @purpose Normalizes getCurrentCommit's "working-tree" sentinel into undefined so lastScannedCommit in the graph never records a fake commit hash.
 * @contract post: returns the resolved commit hash, or undefined when the repo is on an uncommitted working tree (no real commit to diff against next time).
 *   side-effects: none (reads the current commit via getCurrentCommit).
 * @audience technical
 */
function resolveScannedCommit(repoRoot: string): string | undefined {
  const commit = getCurrentCommit(repoRoot);
  return commit === "working-tree" ? undefined : commit;
}

/**
 * @purpose Options for syncUserGuide: whether to force-regenerate every section and which LLM adapter (if any) to use for the LLM-heavy rollups.
 * @audience technical
 */
export interface SyncOptions {
  /** Force-regenerate every section's text even if nothing changed underneath (generate_rollup / `generate user-guide`). */
  force?: boolean;
  /**
   * When provided, also (re)generates Section 4 (Core Features) and
   * Section 5 (Troubleshooting) -- the LLM-heavy rollups (Phase 8).
   * Omitted, syncUserGuide only touches the zero-LLM sections 2-3.
   */
  llm?: LlmAdapter;
}

/**
 * @purpose Return shape of syncUserGuide describing what happened during one read-recompute-write cycle: the updated nodes, the classified changes, which sections changed, whether a revision row was added, and the resulting document.
 * @audience technical
 */
export interface SyncResult {
  currentNodes: DocNode[];
  changes: NodeChange[];
  sectionsChanged: string[];
  revisionRowAdded: boolean;
  documentMarkdown: string;
  crossCheck?: ErrorTroubleshootingCrossCheck;
}

/**
 * @purpose Reads, recomputes, and writes the user guide and doc graph in one shared cycle, used by both the MCP server's update_doc/generate_rollup tools and the CLI's update/generate commands so the two surfaces can't drift apart.
 * @contract pre: repoRoot is the root of a git repo containing (or about to contain) USER_GUIDE.md and the doc graph.
 *   post: scans the repo for AST changes, regenerates system-overview/getting-started (always) and core-features/troubleshooting (only when options.llm is supplied), appends any resulting revision-history rows and per-node entries, writes the updated graph and USER_GUIDE.md to disk, and returns the resulting nodes/changes/sections-changed/document.
 *   side-effects: reads and writes the doc graph file and USER_GUIDE.md on disk; when options.llm is set, makes LLM completion calls for narrative and error-resolution generation.
 * @audience technical
 */
export async function syncUserGuide(repoRoot: string, options: SyncOptions = {}): Promise<SyncResult> {
  const previousGraph = loadGraph(repoRoot);
  const { currentNodes: scannedNodes, changes } = scanRepo(repoRoot, previousGraph);
  const pkg = readPackageMeta(repoRoot);
  const document = readUserGuide(repoRoot);

  let currentNodes = scannedNodes;
  const errorResolutions: Record<string, string> = { ...previousGraph.errorResolutions };
  let crossCheck: ErrorTroubleshootingCrossCheck | undefined;
  const sectionsChanged: string[] = [];
  let updatedDocument = document;

  const graphBeforeNarratives: DocGraph = { nodes: currentNodes, edges: buildEdges(currentNodes) };
  const newSystemOverview = generateSystemOverview(graphBeforeNarratives, pkg);
  const newGettingStarted = generateGettingStarted(pkg);

  if (options.force || newSystemOverview !== readSectionContent(document, "system-overview")) {
    updatedDocument = replaceSectionContent(updatedDocument, "system-overview", newSystemOverview);
    sectionsChanged.push("system-overview");
  }
  if (options.force || newGettingStarted !== readSectionContent(document, "getting-started")) {
    updatedDocument = replaceSectionContent(updatedDocument, "getting-started", newGettingStarted);
    sectionsChanged.push("getting-started");
  }

  if (options.llm) {
    const narrativeResult = await generateNarratives(options.llm, currentNodes, previousGraph, changes);
    currentNodes = narrativeResult.nodes;

    const currentGraph: DocGraph = { nodes: currentNodes, edges: buildEdges(currentNodes) };
    const errorContexts = collectErrorContexts(currentGraph);
    const errorTypesNeedingResolution = [...errorContexts.keys()].filter((errorType) => !(errorType in errorResolutions));
    if (errorTypesNeedingResolution.length > 0) {
      const { resolutions } = await generateErrorResolutions(options.llm, errorTypesNeedingResolution, errorContexts);
      for (const [errorType, resolution] of resolutions) errorResolutions[errorType] = resolution;
    }

    const resolutionsMap = new Map(Object.entries(errorResolutions));
    const newCoreFeatures = generateCoreFeatures(currentGraph);
    const newTroubleshooting = generateTroubleshooting(currentGraph, resolutionsMap);

    if (options.force || newCoreFeatures !== readSectionContent(document, "core-features")) {
      updatedDocument = replaceSectionContent(updatedDocument, "core-features", newCoreFeatures);
      sectionsChanged.push("core-features");
    }
    if (options.force || newTroubleshooting !== readSectionContent(document, "troubleshooting")) {
      updatedDocument = replaceSectionContent(updatedDocument, "troubleshooting", newTroubleshooting);
      sectionsChanged.push("troubleshooting");
    }

    crossCheck = crossCheckErrorsAndTroubleshooting(currentGraph, newTroubleshooting);
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
    errorResolutions,
  });
  writeFileSync(userGuidePath(repoRoot), regeneration.documentMarkdown, "utf8");

  return {
    currentNodes: regeneration.nodes,
    changes,
    sectionsChanged,
    revisionRowAdded: regeneration.addedRevisionRow,
    documentMarkdown: regeneration.documentMarkdown,
    crossCheck,
  };
}
