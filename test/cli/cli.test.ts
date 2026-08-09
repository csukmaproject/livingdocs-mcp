import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));
const CLI_PATH = join(PROJECT_ROOT, "dist/cli/index.js");

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function runCli(args: string[], env: Record<string, string | undefined> = process.env): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], { encoding: "utf8", env });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status ?? 1 };
  }
}

// This is a real end-to-end check per the Phase 5 DoD ("all four commands
// work against the fixture repo from the terminal, independent of any
// agent"), so it exercises the actual built binary rather than the
// underlying functions (already covered by test/core/sync.test.ts etc).
describe("livingdocs CLI (built binary)", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: PROJECT_ROOT, stdio: "ignore" });
    expect(existsSync(CLI_PATH)).toBe(true);
  }, 60_000);

  it("scan reports nothing to do before any generation has happened, then reports the initial extraction", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-cli-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const scan = runCli(["scan", "--repo", tmp]);
      expect(scan.status).toBe(0);
      expect(scan.stdout).toContain("change(s) since last scan");
      expect(scan.stdout).toContain("added");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("update writes USER_GUIDE.md and reports which sections changed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-cli-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const update = runCli(["update", "--repo", tmp]);
      expect(update.status).toBe(0);
      expect(update.stdout).toContain("Sections changed: system-overview, getting-started");
      expect(existsSync(join(tmp, "USER_GUIDE.md"))).toBe(true);

      const noop = runCli(["update", "--repo", tmp]);
      expect(noop.stdout).toContain("Already up to date.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("generate <type> force-generates the user guide, and rejects an unknown type", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-cli-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const generate = runCli(["generate", "user-guide", "--repo", tmp]);
      expect(generate.status).toBe(0);
      expect(generate.stdout).toContain("Generated");
      expect(readFileSync(join(tmp, "USER_GUIDE.md"), "utf8")).toContain("documented-fixture");

      const unknown = runCli(["generate", "prd", "--repo", tmp]);
      expect(unknown.status).not.toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("status reports coverage %, stale nodes, and last sync per section", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-cli-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const before = runCli(["status", "--repo", tmp]);
      expect(before.stdout).toContain("Coverage: 0%");
      expect(before.stdout).toContain("never");

      runCli(["update", "--repo", tmp]);

      const after = runCli(["status", "--repo", tmp]);
      expect(after.stdout).toContain("Coverage: 67%");
      expect(after.stdout).toContain("Stale nodes: none");
      expect(after.stdout).toContain("system-overview: 20"); // real date, not "never"
      expect(after.stdout).toContain("getting-started: 20");
      // No ANTHROPIC_API_KEY in this test env, so the LLM-heavy sections
      // correctly never ran -- still "never" here, not a bug.
      expect(after.stdout).toContain("core-features: never");
      expect(after.stdout).toContain("troubleshooting: never");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bootstrap requires an API key (no MCP host to borrow sampling from out here)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-cli-"));
    try {
      cpSync(fileURLToPath(new URL("../fixtures/undocumented", import.meta.url)), tmp, { recursive: true });
      initGitRepo(tmp);

      const result = runCli(["bootstrap", "--repo", tmp], { ...process.env, ANTHROPIC_API_KEY: "" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ANTHROPIC_API_KEY is required");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
