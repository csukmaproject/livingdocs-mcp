import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { extractRepo } from "../../src/core/extractor.js";
import { diffGraph } from "../../src/core/ast-diff.js";
import {
  appendDocumentRevisionRow,
  applyRegeneration,
  formatRevisionRow,
  parseDocumentRevisionRows,
} from "../../src/core/revision-writer.js";
import type { DocGraph } from "../../src/core/types.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL("../../src/templates/user-guide-template.md", import.meta.url));

describe("revision-writer: appendDocumentRevisionRow", () => {
  it("creates the table on first use", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    const updated = appendDocumentRevisionRow(template, {
      commit: "abc123",
      date: "2026-08-06",
      summary: "initial generation",
    });
    expect(updated).toContain("| Date | Commit | Summary |");
    expect(updated).toContain("| --- | --- | --- |");
    expect(updated).toContain(formatRevisionRow({ commit: "abc123", date: "2026-08-06", summary: "initial generation" }));
  });

  it("appends a second row without touching the first", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    const afterFirst = appendDocumentRevisionRow(template, {
      commit: "abc123",
      date: "2026-08-06",
      summary: "initial generation",
    });
    const afterSecond = appendDocumentRevisionRow(afterFirst, {
      commit: "def456",
      date: "2026-08-07",
      summary: "second regeneration",
    });

    expect(afterSecond).toContain(formatRevisionRow({ commit: "abc123", date: "2026-08-06", summary: "initial generation" }));
    expect(afterSecond).toContain(formatRevisionRow({ commit: "def456", date: "2026-08-07", summary: "second regeneration" }));

    const firstRowIndex = afterSecond.indexOf("abc123");
    const secondRowIndex = afterSecond.indexOf("def456");
    expect(firstRowIndex).toBeGreaterThan(-1);
    expect(secondRowIndex).toBeGreaterThan(firstRowIndex);
  });

  it("escapes pipe characters in the summary so the table doesn't break", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    const updated = appendDocumentRevisionRow(template, {
      commit: "abc123",
      date: "2026-08-06",
      summary: "a | b changed",
    });
    expect(updated).toContain("a \\| b changed");
  });

  it("round-trips rows written by appendDocumentRevisionRow through parseDocumentRevisionRows", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    const afterFirst = appendDocumentRevisionRow(template, {
      commit: "abc123",
      date: "2026-08-06",
      summary: "a | b changed",
    });
    const afterSecond = appendDocumentRevisionRow(afterFirst, {
      commit: "def456",
      date: "2026-08-07",
      summary: "second regeneration",
    });

    expect(parseDocumentRevisionRows(afterSecond)).toEqual([
      { commit: "abc123", date: "2026-08-06", summary: "a | b changed" },
      { commit: "def456", date: "2026-08-07", summary: "second regeneration" },
    ]);
  });

  it("returns an empty array when there's no table yet", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    expect(parseDocumentRevisionRows(template)).toEqual([]);
  });
});

describe("revision-writer: applyRegeneration", () => {
  it("a no-op regeneration adds zero new revision rows and zero new node history entries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-revwriter-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      const template = readFileSync(TEMPLATE_PATH, "utf8");

      // First-ever generation: previous graph is empty, everything is "added".
      const firstNodes = extractRepo(tmp);
      const firstChanges = diffGraph({ nodes: [], edges: [] }, firstNodes);
      const firstResult = applyRegeneration({ nodes: [], edges: [] }, firstNodes, firstChanges, template, "commit1", "2026-08-06");
      expect(firstResult.addedRevisionRow).toBe(true);
      for (const node of firstResult.nodes) {
        expect(node.revisionHistory).toHaveLength(1);
      }

      const previousGraph: DocGraph = { nodes: firstResult.nodes, edges: [] };
      const rowCountBefore = (firstResult.documentMarkdown.match(/^\|/gm) ?? []).length;

      // Second run, nothing changed on disk at all.
      const secondNodes = extractRepo(tmp);
      const secondChanges = diffGraph(previousGraph, secondNodes);
      const secondResult = applyRegeneration(previousGraph, secondNodes, secondChanges, firstResult.documentMarkdown, "commit2", "2026-08-07");

      expect(secondResult.addedRevisionRow).toBe(false);
      expect(secondResult.documentMarkdown).toBe(firstResult.documentMarkdown);
      const rowCountAfter = (secondResult.documentMarkdown.match(/^\|/gm) ?? []).length;
      expect(rowCountAfter).toBe(rowCountBefore);
      for (const node of secondResult.nodes) {
        expect(node.revisionHistory).toHaveLength(1);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a real change produces exactly one new document row with the correct commit SHA, and exactly one new node history entry", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-revwriter-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      const template = readFileSync(TEMPLATE_PATH, "utf8");

      const firstNodes = extractRepo(tmp);
      const firstChanges = diffGraph({ nodes: [], edges: [] }, firstNodes);
      const firstResult = applyRegeneration({ nodes: [], edges: [] }, firstNodes, firstChanges, template, "commit1", "2026-08-06");
      const previousGraph: DocGraph = { nodes: firstResult.nodes, edges: [] };
      const rowCountBefore = (firstResult.documentMarkdown.match(/^\|/gm) ?? []).length;

      const cartPath = join(tmp, "src/cart.ts");
      const original = readFileSync(cartPath, "utf8");
      writeFileSync(
        cartPath,
        original.replace(
          "export function computeTotal(items: number[], discountPercent: number): number {",
          "export function computeTotal(items: number[], discountPercent: number, taxRate: number): number {",
        ),
      );

      const secondNodes = extractRepo(tmp);
      const secondChanges = diffGraph(previousGraph, secondNodes);
      const secondResult = applyRegeneration(previousGraph, secondNodes, secondChanges, firstResult.documentMarkdown, "commit2-real-change", "2026-08-07");

      expect(secondResult.addedRevisionRow).toBe(true);
      const rowCountAfter = (secondResult.documentMarkdown.match(/^\|/gm) ?? []).length;
      expect(rowCountAfter).toBe(rowCountBefore + 1);
      expect(secondResult.documentMarkdown).toContain("commit2-real-change");

      const changedNode = secondResult.nodes.find((n) => n.nodeId === "src/cart.ts#computeTotal:function");
      expect(changedNode?.revisionHistory).toHaveLength(2);
      expect(changedNode?.revisionHistory[1]?.commit).toBe("commit2-real-change");

      const untouchedNode = secondResult.nodes.find((n) => n.nodeId === "src/discounts.ts#normalizeDiscountCode:function");
      expect(untouchedNode?.revisionHistory).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
