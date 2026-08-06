import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { extractRepo } from "../../src/core/extractor.js";
import { getCurrentCommit } from "../../src/core/git.js";
import { scanRepo } from "../../src/core/incremental-extract.js";
import type { DocGraph } from "../../src/core/types.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

describe("scanRepo", () => {
  it("falls back to a full scan when there's no git repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-scan-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      const result = scanRepo(tmp, { nodes: [], edges: [] });
      expect(result.usedGitScoping).toBe(false);
      expect(result.currentNodes.length).toBe(extractRepo(tmp).length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does a full scan on the very first run even with a clean working tree -- a stale/missing graph must not look like 'nothing changed'", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-scan-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp); // working tree is clean immediately after this commit

      // previousGraph has no lastScannedCommit yet -- this is the bootstrap case.
      const result = scanRepo(tmp, { nodes: [], edges: [] });
      expect(result.usedGitScoping).toBe(false);
      expect(result.currentNodes.length).toBe(extractRepo(tmp).length);
      expect(result.changes.every((c) => c.classification === "added")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("only re-extracts git-changed files, reusing previous nodes for the rest", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-scan-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const previousGraph: DocGraph = { nodes: extractRepo(tmp), edges: [], lastScannedCommit: getCurrentCommit(tmp) };

      const cartPath = join(tmp, "src/cart.ts");
      writeFileSync(
        cartPath,
        readFileSync(cartPath, "utf8").replace(
          "export function computeTotal(items: number[], discountPercent: number): number {",
          "export function computeTotal(items: number[], discountPercent: number, taxRate: number): number {",
        ),
      );

      const result = scanRepo(tmp, previousGraph);
      expect(result.usedGitScoping).toBe(true);

      const cartNode = result.currentNodes.find((n) => n.nodeId === "src/cart.ts#computeTotal:function");
      expect(cartNode?.agentContract.signature).toContain("taxRate");

      const discountsChange = result.changes.find((c) => c.nodeId === "src/discounts.ts#normalizeDiscountCode:function");
      expect(discountsChange?.classification).toBe("unchanged");

      const cartChange = result.changes.find((c) => c.nodeId === "src/cart.ts#computeTotal:function");
      expect(cartChange?.classification).toBe("contract-affecting");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("picks up already-committed changes since the last scan, even with a clean working tree", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-scan-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const previousGraph: DocGraph = { nodes: extractRepo(tmp), edges: [], lastScannedCommit: getCurrentCommit(tmp) };

      const cartPath = join(tmp, "src/cart.ts");
      writeFileSync(
        cartPath,
        readFileSync(cartPath, "utf8").replace(
          "export function computeTotal(items: number[], discountPercent: number): number {",
          "export function computeTotal(items: number[], discountPercent: number, taxRate: number): number {",
        ),
      );
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "add taxRate"], { cwd: tmp });
      // Working tree is clean again -- git status alone would report nothing.

      const result = scanRepo(tmp, previousGraph);
      expect(result.usedGitScoping).toBe(true);
      const cartChange = result.changes.find((c) => c.nodeId === "src/cart.ts#computeTotal:function");
      expect(cartChange?.classification).toBe("contract-affecting");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
