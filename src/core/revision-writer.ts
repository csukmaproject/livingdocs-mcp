/**
 * @purpose Maintains the append-only Revision History table in USER_GUIDE.md and the per-node revision log inside the doc graph, so every meaningful change is recorded exactly once per regeneration pass.
 * @audience technical
 */
import type { ChangeClassification, NodeChange } from "./ast-diff.js";
import type { DocGraph, DocNode, RevisionEntry } from "./types.js";

const REVISION_HEADING = "## Revision History";
const TABLE_HEADER = "| Date | Commit | Summary |";
const TABLE_SEPARATOR = "| --- | --- | --- |";

/**
 * @purpose Escapes a value so it can be safely embedded as one cell in a markdown table row.
 * @contract pre: value is any string.
 *   post: returns value with pipe characters escaped and newlines collapsed to spaces.
 *   side-effects: none.
 * @audience technical
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * @purpose Formats one RevisionEntry as a single markdown table row for the Revision History section.
 * @contract post: returns a "| date | commit | summary |" row with each cell escaped via escapeCell.
 *   side-effects: none.
 * @audience technical
 */
export function formatRevisionRow(entry: RevisionEntry): string {
  return `| ${escapeCell(entry.date)} | ${escapeCell(entry.commit)} | ${escapeCell(entry.summary)} |`;
}

/**
 * @purpose Appends one row to the document's "## Revision History" table, creating the header/separator on first use, without ever modifying an existing row.
 * @contract pre: documentMarkdown contains a "## Revision History" heading.
 *   post: returns documentMarkdown with entry inserted as the new last row of the table (building the table under the heading if it doesn't exist yet).
 *   throws: Error when documentMarkdown has no "## Revision History" heading.
 *   side-effects: none.
 * @audience technical
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

/**
 * @purpose Parses the document's "## Revision History" table back into structured RevisionEntry rows.
 * @contract post: returns one RevisionEntry per table row (date, commit, summary, with escaped pipes unescaped), or [] when the heading or its table header is missing or malformed.
 *   side-effects: none.
 * @audience technical
 */
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

/**
 * @purpose Return shape of applyRegeneration: the (possibly updated) document markdown, the nodes with their revision logs carried forward, and whether a document-level revision row was added.
 * @audience technical
 */
export interface RegenerationResult {
  documentMarkdown: string;
  nodes: DocNode[];
  addedRevisionRow: boolean;
}

/**
 * @purpose Builds the one-line human-readable summary used as the "Summary" cell for a document-level revision row.
 * @contract post: returns changes joined as "nodeId (classification)" pairs separated by ", "; returns "" for an empty array.
 *   side-effects: none.
 * @audience technical
 */
function summarizeChanges(changes: NodeChange[]): string {
  return changes.map((c) => `${c.nodeId} (${c.classification})`).join(", ");
}

const MEANINGFUL: ReadonlySet<ChangeClassification> = new Set(["added", "removed", "cosmetic", "contract-affecting"]);

/**
 * @purpose Applies one regeneration pass: carries forward each node's accumulated revision log, appends one new entry to every node that meaningfully changed, and appends one row to the document-level table if anything meaningful changed at all.
 * @contract pre: previousGraph.nodes and currentNodes are keyed by the same nodeId scheme; changes describes the diff between them.
 *   post: returns updatedNodes (revision history carried forward, with a new entry appended for changed nodes), the possibly-updated documentMarkdown, and addedRevisionRow=true only when at least one change is classified added/removed/cosmetic/contract-affecting; changes classified only "unchanged" leave both the document and every node's revision log untouched.
 *   side-effects: none.
 * @audience technical
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
