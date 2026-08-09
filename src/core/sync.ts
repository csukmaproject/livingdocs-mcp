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
  /** Force-regenerate every section's text even if nothing changed underneath (generate_rollup / `generate user-guide`). */
  force?: boolean;
  /**
   * When provided, also (re)generates Section 4 (Core Features) and
   * Section 5 (Troubleshooting) -- the LLM-heavy rollups (Phase 8).
   * Omitted, syncUserGuide only touches the zero-LLM sections 2-3.
   */
  llm?: LlmAdapter;
}

export interface SyncResult {
  currentNodes: DocNode[];
  changes: NodeChange[];
  sectionsChanged: string[];
  revisionRowAdded: boolean;
  documentMarkdown: string;
  crossCheck?: ErrorTroubleshootingCrossCheck;
}

/**
 * Reads, recomputes, and writes the user guide + graph in one place --
 * shared by the MCP server's update_doc/generate_rollup tools and the
 * CLI's update/generate commands (build brief Phase 5: "CLI uses the
 * same core as the MCP server"), so the two surfaces can't drift the way
 * scanRepo's git-scoping once did between them.
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
