import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { generateDocument } from "../../src/core/documents.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

function extractLabels(prompt: string): string[] {
  return [...prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
}

class FakeLlm implements LlmAdapter {
  calls: LlmCompletionRequest[] = [];
  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.calls.push(request);
    const labels = extractLabels(request.prompt);
    if (request.prompt.includes('"requirementId"')) {
      return { text: JSON.stringify(labels.map((id) => ({ requirementId: id, title: id, description: "d", acceptanceCriteria: [] }))) };
    }
    return { text: JSON.stringify(labels.map((nodeId) => ({ nodeId, purpose: "p", rationale: "r" }))) };
  }
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

describe("generateDocument dispatcher", () => {
  it("rejects an unknown document type", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-docs-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const result = await generateDocument(tmp, "changelog", undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Unknown document type");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes each mechanical document type to its own file with no LLM adapter", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-docs-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const cases: Array<[string, string]> = [
        ["agent-contract-reference", "AGENT_CONTRACTS.md"],
        ["srs", "SRS.md"],
        ["technical-guide", "TECHNICAL_GUIDE.md"],
      ];
      for (const [type, filename] of cases) {
        const result = await generateDocument(tmp, type, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.outputPath).toBe(join(tmp, filename));
          expect(existsSync(join(tmp, filename))).toBe(true);
          expect(readFileSync(join(tmp, filename), "utf8")).toBe(`${result.content}\n`);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("business-guide works with no LLM adapter, falling back to the technical narrative", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-docs-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const result = await generateDocument(tmp, "business-guide", undefined);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.content).toContain("Validates and normalizes a discount code");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("business-guide uses the LLM rewrite when an adapter is available", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-docs-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const result = await generateDocument(tmp, "business-guide", new FakeLlm());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.content).toContain("\np\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prd requires an LLM adapter -- fails clearly rather than silently producing an empty document", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-docs-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const result = await generateDocument(tmp, "prd", undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("PRD generation needs cross-node synthesis");
      expect(existsSync(join(tmp, "PRD.md"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prd generates a real document with an LLM adapter, using exactly one batched call", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-docs-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const llm = new FakeLlm();
      const result = await generateDocument(tmp, "prd", llm);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toContain("## REQ-042: REQ-042");
        expect(result.content).toContain("## REQ-043: REQ-043");
      }
      expect(llm.calls).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("routes user-guide through syncUserGuide, including the cross-check when an LLM adapter is passed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-docs-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const llm = new FakeLlm();
      const result = await generateDocument(tmp, "user-guide", llm);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.outputPath).toContain("USER_GUIDE.md");
        expect(result.crossCheck).toBeDefined();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
