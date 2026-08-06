import { execFileSync } from "node:child_process";

/**
 * Files git reports as added/modified/deleted/renamed (staged, unstaged,
 * and untracked), relative to repoRoot. Returns null when git itself isn't
 * usable (not a repo, git not installed) so callers can fall back to a
 * full re-scan instead of erroring.
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
 * Files changed between `sinceCommit` and HEAD (committed history only).
 * Returns null when the ref can't be diffed -- not a git repo, sinceCommit
 * no longer resolves (rebase, shallow clone), or there is no HEAD yet --
 * so callers can fall back to a full scan instead of silently under-scanning.
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
