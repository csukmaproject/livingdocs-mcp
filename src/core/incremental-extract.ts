/**
 * @purpose Orchestrates re-extraction of the repo's doc nodes, choosing between a full scan and a git-scoped incremental scan, and classifies the resulting differences against the previous graph.
 * @audience technical
 */
import { relative } from "node:path";
import { extractFile, walkSourceFiles, extractRepo } from "./extractor.js";
import { getChangedFiles, getChangedFilesSince } from "./git.js";
import { diffGraph } from "./ast-diff.js";
import type { NodeChange } from "./ast-diff.js";
import type { DocGraph, DocNode } from "./types.js";

/**
 * @purpose Shape returned by a repo scan: the full current node set, the classified differences from the previous graph, and whether git-based scoping was used.
 * @audience technical
 */
export interface ScanResult {
  currentNodes: DocNode[];
  changes: NodeChange[];
  usedGitScoping: boolean;
}

/**
 * @purpose Re-extracts every source file in the repo from scratch, used when git-scoped incremental scanning isn't possible.
 * @contract pre: none.
 *   post: returns all current nodes from extractRepo(repoRoot) together with their diff against previousGraph; usedGitScoping is always false.
 *   side-effects: reads every supported source file under repoRoot via extractRepo.
 * @audience technical
 */
function fullScan(repoRoot: string, previousGraph: DocGraph): ScanResult {
  const currentNodes = extractRepo(repoRoot);
  return { currentNodes, changes: diffGraph(previousGraph, currentNodes), usedGitScoping: false };
}

/**
 * @purpose Re-extracts only the files that changed since the graph was last generated, reusing unchanged nodes as-is (docgen-plugin-plan.md Section 9.1, "hash-skip unchanged nodes entirely"), falling back to a full scan whenever git can't reliably determine what changed.
 * @contract pre: none.
 *   post: "changed" is the union of uncommitted working-tree edits (git status) and committed history since previousGraph.lastScannedCommit (git diff), because either alone misses real changes -- git status is blind to already-committed drift, and a commit-range diff is blind to uncommitted edits. Returns unchanged previous nodes plus freshly extracted nodes for changed files, and their diff against previousGraph, with usedGitScoping true. Falls back to fullScan (usedGitScoping false) when git status can't be read at all, or when there's no previousGraph.lastScannedCommit yet -- the very first run, where a clean working tree must NOT be read as "nothing to extract".
 *   side-effects: reads git state and re-reads the changed source files on disk.
 * @audience technical
 */
export function scanRepo(repoRoot: string, previousGraph: DocGraph): ScanResult {
  const uncommitted = getChangedFiles(repoRoot);
  if (uncommitted === null) {
    return fullScan(repoRoot, previousGraph);
  }

  const sinceLastScan = previousGraph.lastScannedCommit
    ? getChangedFilesSince(repoRoot, previousGraph.lastScannedCommit)
    : null;
  if (sinceLastScan === null) {
    return fullScan(repoRoot, previousGraph);
  }

  const changedSet = new Set([...uncommitted, ...sinceLastScan]);
  const unchangedNodes = previousGraph.nodes.filter((n) => !changedSet.has(n.filePath));
  const changedNodes = walkSourceFiles(repoRoot)
    .filter((absPath) => changedSet.has(relative(repoRoot, absPath)))
    .flatMap((absPath) => extractFile(absPath, repoRoot));
  const currentNodes = [...unchangedNodes, ...changedNodes];

  return { currentNodes, changes: diffGraph(previousGraph, currentNodes), usedGitScoping: true };
}
