import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadGraph } from "../../src/core/doc-graph.js";
import { readSectionContent } from "../../src/core/rollup-engine.js";
import { syncUserGuide, userGuidePath } from "../../src/core/sync.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function commitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

/** Extracts every `### <label>` block heading from a prompt -- used to assert which entities/error-types a batched prompt actually covers. */
function extractPromptLabels(prompt: string): string[] {
  return [...prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
}

class FakeLlmAdapter implements LlmAdapter {
  calls: LlmCompletionRequest[] = [];

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.calls.push(request);
    if (request.prompt.includes('"nodeId"')) {
      const nodeIds = extractPromptLabels(request.prompt);
      return {
        text: JSON.stringify(
          nodeIds.map((nodeId) => ({
            nodeId,
            rationale: `rationale for ${nodeId}`,
            example: `example for ${nodeId}`,
            gotchas: [`gotcha for ${nodeId}`],
          })),
        ),
      };
    }
    const errorTypes = extractPromptLabels(request.prompt);
    return {
      text: JSON.stringify(errorTypes.map((errorType) => ({ errorType, resolution: `resolution for ${errorType}` }))),
    };
  }
}

describe("syncUserGuide", () => {
  it("first run populates both zero-LLM sections, writes the graph, and records section sync dates", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const result = await syncUserGuide(tmp);
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

  it("a no-op run changes nothing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const first = await syncUserGuide(tmp);
      const second = await syncUserGuide(tmp);

      expect(second.sectionsChanged).toEqual([]);
      expect(second.revisionRowAdded).toBe(false);
      expect(second.documentMarkdown).toBe(first.documentMarkdown);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("regenerates only the section a module-purpose edit actually affects", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      await syncUserGuide(tmp);

      const indexPath = join(tmp, "src/index.ts");
      writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace("wires discount", "wires discount, tax,"));

      const result = await syncUserGuide(tmp);
      expect(result.sectionsChanged).toEqual(["system-overview"]);
      expect(readSectionContent(result.documentMarkdown, "system-overview")).toContain("wires discount, tax,");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("force mode regenerates both zero-LLM sections even with nothing stale", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      await syncUserGuide(tmp);

      const result = await syncUserGuide(tmp, { force: true });
      expect(result.sectionsChanged).toEqual(expect.arrayContaining(["system-overview", "getting-started"]));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("syncUserGuide with an LLM adapter (Phase 8)", () => {
  it("first run generates Core Features + Troubleshooting, tags every generated field 'inferred', and the cross-check is clean", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-llm-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const llm = new FakeLlmAdapter();

      const result = await syncUserGuide(tmp, { llm });
      expect(result.sectionsChanged).toEqual(
        expect.arrayContaining(["system-overview", "getting-started", "core-features", "troubleshooting"]),
      );

      const coreFeatures = readSectionContent(result.documentMarkdown, "core-features");
      expect(coreFeatures).toContain("rationale for src/cart.ts#computeTotal:function");
      expect(coreFeatures).toContain("rationale for src/discounts.ts#normalizeDiscountCode:function");

      const troubleshooting = readSectionContent(result.documentMarkdown, "troubleshooting");
      expect(troubleshooting).toContain("InvalidDiscountError");
      expect(troubleshooting).toContain("resolution for InvalidDiscountError");

      const cartNode = result.currentNodes.find((n) => n.nodeId === "src/cart.ts#computeTotal:function");
      expect(cartNode?.confidence["humanNarrative.rationale"]).toBe("inferred");
      expect(cartNode?.confidence["humanNarrative.example"]).toBe("inferred");
      expect(cartNode?.confidence["humanNarrative.gotchas"]).toBe("inferred");
      expect(cartNode?.confidence["agentContract.signature"]).toBe("extracted");

      expect(result.crossCheck).toEqual({ missingFromTroubleshooting: [], orphanedInTroubleshooting: [] });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("editing one feature function only sends that feature to the model, and only its subsection changes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-llm-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const llm = new FakeLlmAdapter();
      const first = await syncUserGuide(tmp, { llm });
      const coreFeaturesBefore = readSectionContent(first.documentMarkdown, "core-features");

      const cartPath = join(tmp, "src/cart.ts");
      writeFileSync(
        cartPath,
        readFileSync(cartPath, "utf8").replace(
          "export function computeTotal(items: number[], discountPercent: number): number {",
          "export function computeTotal(items: number[], discountPercent: number, taxRate: number): number {",
        ),
      );
      commitAll(tmp, "add taxRate");

      const secondLlm = new FakeLlmAdapter();
      const second = await syncUserGuide(tmp, { llm: secondLlm });

      // Only one model call, covering only the changed feature.
      expect(secondLlm.calls).toHaveLength(1);
      expect(extractPromptLabels(secondLlm.calls[0]!.prompt)).toEqual(["src/cart.ts#computeTotal:function"]);

      expect(second.sectionsChanged).toContain("core-features");
      const coreFeaturesAfter = readSectionContent(second.documentMarkdown, "core-features");
      expect(coreFeaturesAfter).toContain("taxRate");

      // The untouched feature's generated narrative is untouched -- same
      // rationale/example/gotchas text as before the edit. (Comparing via
      // substring rather than a full subsection slice, since node order can
      // shift between an initial full scan and a git-scoped rescan.)
      expect(coreFeaturesBefore).toContain("rationale for src/discounts.ts#normalizeDiscountCode:function");
      expect(coreFeaturesAfter).toContain("rationale for src/discounts.ts#normalizeDiscountCode:function");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a cosmetic edit does not call the model and keeps the previously-generated narrative", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-llm-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      await syncUserGuide(tmp, { llm: new FakeLlmAdapter() });

      const cartPath = join(tmp, "src/cart.ts");
      writeFileSync(
        cartPath,
        readFileSync(cartPath, "utf8").replace(
          "Computes the final cart total after a discount is applied.",
          "Computes the final shopping cart total once a discount is applied.",
        ),
      );
      commitAll(tmp, "reword purpose");

      const llm = new FakeLlmAdapter();
      const result = await syncUserGuide(tmp, { llm });

      expect(llm.calls).toHaveLength(0);
      const cartNode = result.currentNodes.find((n) => n.nodeId === "src/cart.ts#computeTotal:function");
      expect(cartNode?.humanNarrative.rationale).toBe("rationale for src/cart.ts#computeTotal:function");
      expect(cartNode?.confidence["humanNarrative.rationale"]).toBe("inferred");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags an error type with no troubleshooting row instead of silently dropping it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-llm-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      const result = await syncUserGuide(tmp, {
        llm: new FakeLlmAdapter(),
        force: true,
      });
      // Manually corrupt the rendered document to simulate drift: strip the
      // InvalidDiscountError row out of Troubleshooting without touching the
      // graph, then re-run the cross-check logic used inside syncUserGuide.
      const withoutRow = result.documentMarkdown.replace(/\| InvalidDiscountError \|.*\|\n/, "");
      writeFileSync(userGuidePath(tmp), withoutRow, "utf8");

      const { crossCheckErrorsAndTroubleshooting } = await import("../../src/core/rollup-engine.js");
      const graph = loadGraph(tmp);
      const troubleshooting = readSectionContent(withoutRow, "troubleshooting");
      const crossCheck = crossCheckErrorsAndTroubleshooting(graph, troubleshooting);
      expect(crossCheck.missingFromTroubleshooting).toEqual(["InvalidDiscountError"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not re-request a resolution for an error type it already has", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-sync-llm-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);
      await syncUserGuide(tmp, { llm: new FakeLlmAdapter() });

      // A contract-affecting edit to a function with NO error modes -- the
      // set of distinct error types in the graph (just InvalidDiscountError,
      // from a different file) doesn't change, so a resolution call would
      // be wasted; a node-narrative call should still happen.
      const cartPath = join(tmp, "src/cart.ts");
      writeFileSync(
        cartPath,
        readFileSync(cartPath, "utf8").replace(
          "export function computeTotal(items: number[], discountPercent: number): number {",
          "export function computeTotal(items: number[], discountPercent: number, taxRate: number): number {",
        ),
      );
      commitAll(tmp, "add taxRate");

      const llm = new FakeLlmAdapter();
      await syncUserGuide(tmp, { llm });

      const narrativeCalls = llm.calls.filter((c) => c.prompt.includes('"nodeId"'));
      const resolutionCalls = llm.calls.filter((c) => !c.prompt.includes('"nodeId"'));
      expect(narrativeCalls).toHaveLength(1);
      expect(resolutionCalls).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
