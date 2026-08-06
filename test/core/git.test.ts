import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChangedFiles, getCurrentCommit } from "../../src/core/git.js";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

describe("git helpers", () => {
  it("returns null for a directory that isn't a git repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-git-"));
    try {
      expect(getChangedFiles(tmp)).toBeNull();
      expect(getCurrentCommit(tmp)).toBe("working-tree");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports untracked and modified files, and resolves the current commit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-git-"));
    try {
      initGitRepo(tmp);
      writeFileSync(join(tmp, "a.txt"), "one");
      execFileSync("git", ["add", "a.txt"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });

      expect(getChangedFiles(tmp)).toEqual([]);
      expect(getCurrentCommit(tmp)).toMatch(/^[0-9a-f]{6,}$/);

      writeFileSync(join(tmp, "a.txt"), "two");
      writeFileSync(join(tmp, "b.txt"), "new file");
      const changed = getChangedFiles(tmp);
      expect(changed).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
