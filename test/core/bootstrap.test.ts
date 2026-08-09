import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { insertAnnotationComments, listUndocumentedEntities } from "../../src/core/extractor.js";
import {
  clusterByNaming,
  formatAnnotationComment,
  loadSeed,
  mineGitCoChange,
  mineTestReferences,
  runBootstrap,
  saveSeed,
  seedPath,
  type BootstrapSeed,
  type ProposedAnnotation,
} from "../../src/core/bootstrap.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";

const UNDOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/undocumented", import.meta.url));
const DOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function extractPromptKeys(prompt: string): string[] {
  return [...prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
}

class FakeSynthesisLlm implements LlmAdapter {
  calls: LlmCompletionRequest[] = [];
  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.calls.push(request);
    const keys = extractPromptKeys(request.prompt);
    const proposals: ProposedAnnotation[] = keys.map((key) => ({
      key,
      purpose: `purpose for ${key}`,
      contractPre: ["pre for " + key],
      contractPost: ["post for " + key],
      contractSideEffects: "none",
      audience: ["technical"],
    }));
    return { text: JSON.stringify(proposals) };
  }
}

describe("listUndocumentedEntities", () => {
  it("finds every declaration with no doc comment in the undocumented fixture", () => {
    const entities = listUndocumentedEntities(UNDOCUMENTED_ROOT);
    const keys = entities.map((e) => `${e.filePath}#${e.entityName}`).sort();
    expect(keys).toEqual([
      "src/rate-limiter.ts#RateLimitExceededError",
      "src/rate-limiter.ts#RateLimiter",
      "src/slug.ts#EmptyTitleError",
      "src/slug.ts#slugify",
    ]);
  });

  it("skips already-documented entities but still catches partially-documented files", () => {
    // discounts.ts has normalizeDiscountCode documented but InvalidDiscountError is not.
    const entities = listUndocumentedEntities(DOCUMENTED_ROOT);
    expect(entities.map((e) => e.entityName)).toEqual(["InvalidDiscountError"]);
  });
});

describe("mineTestReferences", () => {
  it("finds the test file that references an entity by name", () => {
    const entities = listUndocumentedEntities(UNDOCUMENTED_ROOT);
    const refs = mineTestReferences(UNDOCUMENTED_ROOT, entities);
    expect(refs.get("src/slug.ts#slugify")).toEqual(["test/slug.test.ts"]);
    expect(refs.has("src/rate-limiter.ts#RateLimiter")).toBe(false);
  });
});

describe("mineGitCoChange", () => {
  it("groups files that historically changed in the same commit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-cochange-"));
    try {
      writeFileSync(join(tmp, "a.txt"), "1");
      writeFileSync(join(tmp, "b.txt"), "1");
      initGitRepo(tmp);
      writeFileSync(join(tmp, "a.txt"), "2");
      writeFileSync(join(tmp, "b.txt"), "2");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: tmp });

      const coChange = mineGitCoChange(tmp);
      expect(coChange.get("a.txt")).toContain("b.txt");
      expect(coChange.get("b.txt")).toContain("a.txt");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns an empty map when there's no git repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-cochange-"));
    try {
      expect(mineGitCoChange(tmp).size).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("clusterByNaming", () => {
  it("groups entities sharing a significant name fragment", () => {
    const entities = listUndocumentedEntities(UNDOCUMENTED_ROOT);
    const clusters = clusterByNaming(entities);
    const rateCluster = clusters.get("rate");
    expect(rateCluster).toEqual(
      expect.arrayContaining(["src/rate-limiter.ts#RateLimiter", "src/rate-limiter.ts#RateLimitExceededError"]),
    );
  });
});

describe("formatAnnotationComment", () => {
  it("renders a visibly-flagged, correctly-tagged comment block", () => {
    const comment = formatAnnotationComment({
      key: "src/slug.ts#slugify",
      purpose: "Converts a title into a URL slug.",
      contractPre: ["title is a string"],
      contractPost: ["returns a lowercase hyphenated slug"],
      contractSideEffects: "none",
      audience: ["technical"],
    });
    expect(comment).toContain("INFERRED by livingdocs bootstrap");
    expect(comment).toContain("@purpose Converts a title into a URL slug.");
    expect(comment).toContain("pre: title is a string.");
    expect(comment).toContain("post: returns a lowercase hyphenated slug.");
    expect(comment).toContain("side-effects: none.");
    expect(comment).toContain("@audience technical");
    expect(comment.startsWith("/**")).toBe(true);
    expect(comment.endsWith("*/")).toBe(true);
  });
});

describe("insertAnnotationComments", () => {
  it("inserts multiple comments without earlier insertions invalidating later offsets", () => {
    const source = "AAAA\nBBBB\nCCCC\n";
    const result = insertAnnotationComments(source, [
      { insertionIndex: 10, commentBlock: "/* second */" },
      { insertionIndex: 0, commentBlock: "/* first */" },
    ]);
    expect(result).toBe("/* first */\nAAAA\nBBBB\n/* second */\nCCCC\n");
  });
});

describe("seed questions", () => {
  it("round-trips saved answers and they persist across loads", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-seed-"));
    try {
      expect(loadSeed(tmp)).toBeNull();
      const seed: BootstrapSeed = { questions: ["Q1?"], answers: ["A1"], answeredAt: "2026-01-01T00:00:00.000Z" };
      saveSeed(tmp, seed);
      expect(loadSeed(tmp)).toEqual(seed);
      expect(readFileSync(seedPath(tmp), "utf8")).toContain("A1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runBootstrap", () => {
  it("produces a reviewable branch with INFERRED annotations and a correct coverage report", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-bootstrap-"));
    try {
      cpSync(UNDOCUMENTED_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const originalBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

      const llm = new FakeSynthesisLlm();
      const result = await runBootstrap(tmp, { llm, seed: null });

      expect(result.coverageBefore).toBe(0);
      expect(result.coverageAfter).toBe(100);
      expect(result.filesChanged.sort()).toEqual(["src/rate-limiter.ts", "src/slug.ts"]);
      expect(result.proposedEntities).toHaveLength(4);
      expect(llm.calls).toHaveLength(1); // one batched call, not one per entity

      // Committed to a NEW branch, not the one that was checked out.
      expect(result.branchName).toBe("livingdocs-bootstrap");
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
      expect(currentBranch).toBe(originalBranch);
      const branches = execFileSync("git", ["branch", "--list"], { cwd: tmp, encoding: "utf8" });
      expect(branches).toContain("livingdocs-bootstrap");

      // No remote configured in this test repo -- reported honestly, not silently claimed as pushed.
      expect(result.pushed).toBe(false);
      expect(result.prUrl).toBeNull();

      const slugSource = execFileSync("git", ["show", "livingdocs-bootstrap:src/slug.ts"], { cwd: tmp, encoding: "utf8" });
      expect(slugSource).toContain("INFERRED by livingdocs bootstrap");
      expect(slugSource).toContain("@purpose purpose for src/slug.ts#slugify");

      // The original branch's working tree is untouched by the proposal.
      const workingTreeSlug = readFileSync(join(tmp, "src/slug.ts"), "utf8");
      expect(workingTreeSlug).not.toContain("INFERRED");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes seed answers through to the synthesis prompt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-bootstrap-"));
    try {
      cpSync(UNDOCUMENTED_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const llm = new FakeSynthesisLlm();
      const seed: BootstrapSeed = {
        questions: ["What problem does this solve?"],
        answers: ["Rate-limits noisy API clients."],
        answeredAt: "2026-01-01T00:00:00.000Z",
      };

      await runBootstrap(tmp, { llm, seed });

      expect(llm.calls[0]!.prompt).toContain("Rate-limits noisy API clients.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does nothing when every documentable entity is already annotated", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-bootstrap-"));
    try {
      cpSync(DOCUMENTED_ROOT, tmp, { recursive: true });
      // Document the one remaining gap so the fixture is fully covered.
      const discountsPath = join(tmp, "src/discounts.ts");
      writeFileSync(
        discountsPath,
        readFileSync(discountsPath, "utf8").replace(
          "export class InvalidDiscountError extends Error {}",
          "/**\n * @purpose Raised when a discount code fails validation.\n */\nexport class InvalidDiscountError extends Error {}",
        ),
      );
      initGitRepo(tmp);

      const llm = new FakeSynthesisLlm();
      const result = await runBootstrap(tmp, { llm, seed: null });

      expect(result.filesChanged).toEqual([]);
      expect(llm.calls).toHaveLength(0);
      expect(result.coverageBefore).toBe(100);
      expect(result.coverageAfter).toBe(100);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
