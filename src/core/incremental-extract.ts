import { relative } from "node:path";
import { extractFile, walkSourceFiles, extractRepo } from "./extractor.js";
import { getChangedFiles, getChangedFilesSince } from "./git.js";
import { diffGraph } from "./ast-diff.js";
import type { NodeChange } from "./ast-diff.js";
import type { DocGraph, DocNode } from "./types.js";

export interface ScanResult {
  currentNodes: DocNode[];
  changes: NodeChange[];
  usedGitScoping: boolean;
}

function fullScan(repoRoot: string, previousGraph: DocGraph): ScanResult {
  const currentNodes = extractRepo(repoRoot);
  return { currentNodes, changes: diffGraph(previousGraph, currentNodes), usedGitScoping: false };
}

/**
 * Re-extracts only the files that changed since the graph was last
 * generated, reusing unchanged nodes as-is -- docgen-plugin-plan.md
 * Section 9.1 ("hash-skip unchanged nodes entirely"). "Changed" is the
 * union of uncommitted working-tree edits (git status) and committed
 * history since previousGraph.lastScannedCommit (git diff), because
 * either one alone misses real changes: git status is blind to already
 * -committed drift, and a commit-range diff is blind to uncommitted edits.
 * Falls back to a full repo re-scan whenever git can't answer either
 * question -- not a git repo, or there's no lastScannedCommit yet (the
 * very first run, where a clean working tree must NOT be read as "nothing
 * to extract").
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
