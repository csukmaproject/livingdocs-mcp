import type { ChangeClassification, NodeChange } from "./ast-diff.js";
import type { DocGraph, DocNode, RevisionEntry } from "./types.js";

const REVISION_HEADING = "## Revision History";
const TABLE_HEADER = "| Date | Commit | Summary |";
const TABLE_SEPARATOR = "| --- | --- | --- |";

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatRevisionRow(entry: RevisionEntry): string {
  return `| ${escapeCell(entry.date)} | ${escapeCell(entry.commit)} | ${escapeCell(entry.summary)} |`;
}

/**
 * Appends one row to the document's Revision History table, creating the
 * table on first use. Never touches an existing row -- only ever inserts
 * after the last one.
 */
export function appendDocumentRevisionRow(documentMarkdown: string, entry: RevisionEntry): string {
  const lines = documentMarkdown.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === REVISION_HEADING);
  if (headingIndex === -1) {
    throw new Error(`Document has no "${REVISION_HEADING}" section to append a revision row to.`);
  }

  const newRow = formatRevisionRow(entry);

  let cursor = headingIndex + 1;
  while (cursor < lines.length && lines[cursor]?.trim() === "") cursor++;

  const hasTable = (lines[cursor]?.trim() ?? "").startsWith("|");

  if (!hasTable) {
    lines.splice(headingIndex + 1, cursor - (headingIndex + 1), "", TABLE_HEADER, TABLE_SEPARATOR, newRow, "");
    return lines.join("\n");
  }

  let lastTableLine = cursor;
  while (lastTableLine < lines.length && (lines[lastTableLine]?.trim() ?? "").startsWith("|")) {
    lastTableLine++;
  }
  lines.splice(lastTableLine, 0, newRow);
  return lines.join("\n");
}

/** Reads the document-level Revision History table back into structured rows. */
export function parseDocumentRevisionRows(documentMarkdown: string): RevisionEntry[] {
  const lines = documentMarkdown.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === REVISION_HEADING);
  if (headingIndex === -1) return [];

  let cursor = headingIndex + 1;
  while (cursor < lines.length && lines[cursor]?.trim() === "") cursor++;
  if ((lines[cursor]?.trim() ?? "") !== TABLE_HEADER) return [];
  cursor += 2; // skip header + separator

  const rows: RevisionEntry[] = [];
  while (cursor < lines.length && (lines[cursor]?.trim() ?? "").startsWith("|")) {
    const line = lines[cursor]?.trim() ?? "";
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
    const [date, commit, summary] = cells;
    if (date && commit) {
      rows.push({ date, commit, summary: summary ?? "" });
    }
    cursor++;
  }
  return rows;
}

export interface RegenerationResult {
  documentMarkdown: string;
  nodes: DocNode[];
  addedRevisionRow: boolean;
}

function summarizeChanges(changes: NodeChange[]): string {
  return changes.map((c) => `${c.nodeId} (${c.classification})`).join(", ");
}

const MEANINGFUL: ReadonlySet<ChangeClassification> = new Set(["added", "removed", "cosmetic", "contract-affecting"]);

/**
 * Applies one regeneration pass: carries forward every node's accumulated
 * per-node revision log, appends exactly one new entry to each node that
 * actually changed, and appends exactly one row to the document-level
 * table if anything changed at all. A no-op regeneration (every change
 * classified "unchanged") touches neither the document nor any node's
 * revision log.
 */
export function applyRegeneration(
  previousGraph: DocGraph,
  currentNodes: DocNode[],
  changes: NodeChange[],
  documentMarkdown: string,
  commit: string,
  date: string,
): RegenerationResult {
  const previousById = new Map(previousGraph.nodes.map((n) => [n.nodeId, n]));
  const meaningfulChanges = changes.filter((c) => MEANINGFUL.has(c.classification));
  const changeByNodeId = new Map(meaningfulChanges.map((c) => [c.nodeId, c]));

  const updatedNodes = currentNodes.map((node) => {
    const previous = previousById.get(node.nodeId);
    const baseHistory = previous?.revisionHistory ?? [];
    const change = changeByNodeId.get(node.nodeId);
    if (!change) {
      return { ...node, revisionHistory: baseHistory };
    }
    return { ...node, revisionHistory: [...baseHistory, { commit, date, summary: change.reason }] };
  });

  if (meaningfulChanges.length === 0) {
    return { documentMarkdown, nodes: updatedNodes, addedRevisionRow: false };
  }

  const updatedDocument = appendDocumentRevisionRow(documentMarkdown, {
    commit,
    date,
    summary: summarizeChanges(meaningfulChanges),
  });

  return { documentMarkdown: updatedDocument, nodes: updatedNodes, addedRevisionRow: true };
}
