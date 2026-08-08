import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadGraph } from "../../src/core/doc-graph.js";
import { readSectionContent } from "../../src/core/rollup-engine.js";
import { syncUserGuide, userGuidePath } from "../../src/core/sync.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

describe("syncUserGuide", () => {
  it("first run populates both sections, writes the graph, and records section sync dates", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const result = syncUserGuide(tmp);
      expect(result.sectionsChanged).toEqual(expect.arrayContaining(["system-overview", "getting-started"]));
      expect(result.revisionRowAdded).toBe(true);
      expect(readFileSync(userGuidePath(tmp), "utf8")).toBe(result.documentMarkdown);

      const graph = loadGraph(tmp);
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.lastScannedCommit).toBeDefined();
      expect(graph.sectionSyncDates?.["system-overview"]).toBeDefined();
      expect(graph.sectionSyncDates?.["getting-started"]).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a no-op run changes nothing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const first = syncUserGuide(tmp);
      const second = syncUserGuide(tmp);

      expect(second.sectionsChanged).toEqual([]);
      expect(second.revisionRowAdded).toBe(false);
      expect(second.documentMarkdown).toBe(first.documentMarkdown);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("regenerates only the section a module-purpose edit actually affects", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      syncUserGuide(tmp);

      const indexPath = join(tmp, "src/index.ts");
      writeFileSync(
        indexPath,
        readFileSync(indexPath, "utf8").replace("wires discount", "wires discount, tax,"),
      );

      const result = syncUserGuide(tmp);
      expect(result.sectionsChanged).toEqual(["system-overview"]);
      expect(readSectionContent(result.documentMarkdown, "system-overview")).toContain("wires discount, tax,");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("force mode regenerates both sections even with nothing stale", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      syncUserGuide(tmp);

      const result = syncUserGuide(tmp, { force: true });
      expect(result.sectionsChanged).toEqual(expect.arrayContaining(["system-overview", "getting-started"]));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
