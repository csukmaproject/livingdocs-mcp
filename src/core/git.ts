/**
 * @purpose Wraps git CLI invocations used to scope incremental extraction to changed files and to identify the current commit.
 * @audience technical
 */
import { execFileSync } from "node:child_process";

/**
 * @purpose Lists files git reports as added/modified/deleted/renamed across staged, unstaged, and untracked changes, so an incremental scan can be limited to the working tree's actual edits.
 * @contract pre: repoRoot is a path git can be invoked in.
 *   post: returns paths (relative to repoRoot) parsed from `git status --porcelain --untracked-files=all`, deduplicated.
 *   side-effects: none (git is invoked read-only); returns null instead of throwing when git itself isn't usable (not a repo, git not installed) so callers can fall back to a full re-scan instead of erroring.
 * @audience technical
 */
export function getChangedFiles(repoRoot: string): string[] | null {
  try {
    const output = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = new Set<string>();
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const path = line.slice(3).split(" -> ").pop();
      if (path) files.add(path.trim());
    }
    return [...files];
  } catch {
    return null;
  }
}

/**
 * @purpose Lists files changed between a prior commit and HEAD, so an incremental scan can account for committed history since the graph was last generated.
 * @contract pre: repoRoot is a path git can be invoked in.
 *   post: returns paths from `git diff --name-only sinceCommit HEAD`, trimmed and filtered of blank lines.
 *   side-effects: none (git is invoked read-only); returns null instead of throwing when the ref can't be diffed -- not a git repo, sinceCommit no longer resolves (rebase, shallow clone), or there is no HEAD yet -- so callers can fall back to a full scan instead of silently under-scanning.
 * @audience technical
 */
export function getChangedFilesSince(repoRoot: string, sinceCommit: string): string[] | null {
  try {
    const output = execFileSync("git", ["diff", "--name-only", sinceCommit, "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * @purpose Gets a short identifier for HEAD so a generated graph can record which commit it reflects.
 * @contract pre: repoRoot is a path git can be invoked in.
 *   post: returns the trimmed output of `git rev-parse --short HEAD`.
 *   side-effects: none (git is invoked read-only); returns the literal string "working-tree" instead of throwing when git isn't usable, so callers always get a usable label.
 * @audience technical
 */
export function getCurrentCommit(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "working-tree";
  }
}
