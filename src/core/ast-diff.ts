import type { DocGraph, DocNode } from "./types.js";

export type ChangeClassification = "added" | "removed" | "unchanged" | "cosmetic" | "contract-affecting";

export interface NodeChange {
  nodeId: string;
  previousNodeId?: string;
  classification: ChangeClassification;
  reason: string;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function contractFieldsEqual(a: DocNode, b: DocNode): boolean {
  const key = (n: DocNode) =>
    JSON.stringify({
      pre: n.agentContract.preconditions,
      post: n.agentContract.postconditions,
      side: n.agentContract.sideEffects,
      errors: n.agentContract.errorModes,
      deps: n.agentContract.dependencies,
    });
  return key(a) === key(b);
}

function classifyMatchedPair(previous: DocNode, current: DocNode): NodeChange {
  if (previous.contentHash === current.contentHash) {
    return { nodeId: current.nodeId, classification: "unchanged", reason: "content hash unchanged" };
  }
  const signatureChanged = previous.agentContract.signature !== current.agentContract.signature;
  const contractChanged = !contractFieldsEqual(previous, current);
  if (signatureChanged || contractChanged) {
    return {
      nodeId: current.nodeId,
      classification: "contract-affecting",
      reason: signatureChanged ? "signature changed" : "documented contract changed",
    };
  }
  // Signature and documented contract are byte-identical, so the only thing
  // that moved the hash is prose/body text (comment wording, implementation
  // details, formatting) -- nothing an agent's contract-level view depends on.
  return {
    nodeId: current.nodeId,
    classification: "cosmetic",
    reason: "only prose/body text changed, signature and contract unchanged",
  };
}

/**
 * Pairs likely renames: same file + entityType, declaration identical apart
 * from the entity's own name. Needed because nodeId is name-derived, so a
 * plain rename would otherwise look like an unrelated remove+add instead of
 * one cosmetic change. Best-effort heuristic, not a guarantee.
 */
function findRenamePairs(removedCandidates: DocNode[], addedCandidates: DocNode[]): Map<string, DocNode> {
  const pairs = new Map<string, DocNode>();
  const usedPrevious = new Set<string>();
  for (const added of addedCandidates) {
    const match = removedCandidates.find(
      (removed) =>
        !usedPrevious.has(removed.nodeId) &&
        removed.filePath === added.filePath &&
        removed.entityType === added.entityType &&
        removed.entityName !== added.entityName &&
        normalizeWhitespace(removed.agentContract.signature.split(removed.entityName).join("")) ===
          normalizeWhitespace(added.agentContract.signature.split(added.entityName).join("")),
    );
    if (match) {
      pairs.set(added.nodeId, match);
      usedPrevious.add(match.nodeId);
    }
  }
  return pairs;
}

export function diffGraph(previous: DocGraph, currentNodes: DocNode[]): NodeChange[] {
  const changes: NodeChange[] = [];
  const previousById = new Map(previous.nodes.map((n) => [n.nodeId, n]));
  const matchedCurrentIds = new Set<string>();
  const matchedPreviousIds = new Set<string>();

  for (const current of currentNodes) {
    const previousNode = previousById.get(current.nodeId);
    if (previousNode) {
      changes.push(classifyMatchedPair(previousNode, current));
      matchedCurrentIds.add(current.nodeId);
      matchedPreviousIds.add(previousNode.nodeId);
    }
  }

  const unmatchedPrevious = previous.nodes.filter((n) => !matchedPreviousIds.has(n.nodeId));
  const unmatchedCurrent = currentNodes.filter((n) => !matchedCurrentIds.has(n.nodeId));
  const renamePairs = findRenamePairs(unmatchedPrevious, unmatchedCurrent);
  const renamedFromIds = new Set([...renamePairs.values()].map((v) => v.nodeId));

  for (const current of unmatchedCurrent) {
    const renamedFrom = renamePairs.get(current.nodeId);
    if (renamedFrom) {
      changes.push({
        nodeId: current.nodeId,
        previousNodeId: renamedFrom.nodeId,
        classification: "cosmetic",
        reason: `renamed from ${renamedFrom.entityName}`,
      });
    } else {
      changes.push({ nodeId: current.nodeId, classification: "added", reason: "new node" });
    }
  }

  for (const previousNode of unmatchedPrevious) {
    if (!renamedFromIds.has(previousNode.nodeId)) {
      changes.push({ nodeId: previousNode.nodeId, classification: "removed", reason: "node no longer present" });
    }
  }

  return changes;
}
