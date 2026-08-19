import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { countDocumentableEntities, extractRepo, listUndocumentedEntities } from "../../src/core/extractor.js";
import { mineTestReferences, runBootstrap } from "../../src/core/bootstrap.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";

const DOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/documented-go", import.meta.url));
const UNDOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/undocumented-go", import.meta.url));

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

class FakeSynthesisLlm implements LlmAdapter {
  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const keys = [...request.prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
    const proposals = keys.map((key) => ({
      key,
      purpose: `purpose for ${key}`,
      contractPre: [],
      contractPost: [],
      contractSideEffects: "none",
      audience: ["technical"],
    }));
    return { text: JSON.stringify(proposals) };
  }
}

describe("Go extraction", () => {
  it("extracts function, method, struct, and interface nodes documented with // doc-comment runs", () => {
    const nodes = extractRepo(DOCUMENTED_ROOT);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    const add = byId.get("service.go#Add:function");
    expect(add).toBeDefined();
    expect(add?.humanNarrative.purpose).toBe("Adds two integers together.");
    expect(add?.tags).toContain("requirement:REQ-100");
    expect(add?.agentContract.preconditions).toEqual(["a and b are finite ints"]);
    expect(add?.agentContract.postconditions).toEqual(["returns a + b"]);

    const multiplier = byId.get("service.go#Multiplier:struct");
    expect(multiplier).toBeDefined();
    expect(multiplier?.entityType).toBe("struct");

    const scale = byId.get("service.go#Scale:method");
    expect(scale).toBeDefined();
    expect(scale?.entityType).toBe("method");

    const shape = byId.get("service.go#Shape:interface");
    expect(shape).toBeDefined();
    expect(shape?.entityType).toBe("interface");

    const userId = byId.get("service.go#UserID:type");
    expect(userId).toBeDefined();
    expect(userId?.entityType).toBe("type");

    // Undocumented declarations produce no node.
    expect(byId.has("service.go#Subtract:function")).toBe(false);
    expect(byId.has("service.go#internalCounter:struct")).toBe(false);
    // Blank-line-separated comment must not attach to the declaration after it.
    expect(byId.has("service.go#Gadget:struct")).toBe(false);
    // Grouped `type (...)` blocks are skipped entirely in v1.
    expect(byId.has("service.go#GroupedA:struct")).toBe(false);
    expect(byId.has("service.go#GroupedB:interface")).toBe(false);

    const moduleNode = byId.get("service.go#module");
    expect(moduleNode).toBeDefined();
    expect(moduleNode?.humanNarrative.purpose).toBe("Fixture package covering Go's documentable declaration shapes.");
  });

  it("counts every recognized declaration, including undocumented ones, but not grouped type-block members", () => {
    // Documentable: Add, Subtract, Multiplier, Scale, Shape, UserID, internalCounter, Gadget = 8.
    // GroupedA/GroupedB are invisible (grouped block skipped), not just undocumented.
    expect(countDocumentableEntities(DOCUMENTED_ROOT)).toBe(8);
    const documented = extractRepo(DOCUMENTED_ROOT).filter((n) => n.entityType !== "module").length;
    expect(documented).toBe(5);
  });

  it("lists exactly the undocumented declarations, excluding grouped-block members", () => {
    const entities = listUndocumentedEntities(DOCUMENTED_ROOT);
    expect(entities.map((e) => e.entityName).sort()).toEqual(["Gadget", "Subtract", "internalCounter"]);
  });
});

describe("Go bootstrap round-trip", () => {
  it("mines the _test.go file as a test reference", () => {
    const entities = listUndocumentedEntities(UNDOCUMENTED_ROOT);
    const refs = mineTestReferences(UNDOCUMENTED_ROOT, entities);
    expect(refs.get("gadget.go#Widgetize")).toEqual(["gadget_test.go"]);
  });

  it("writes syntactically valid // doc comments that extractRepo can then read back", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-go-bootstrap-"));
    try {
      cpSync(UNDOCUMENTED_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const result = await runBootstrap(tmp, { llm: new FakeSynthesisLlm(), seed: null });
      expect(result.coverageAfter).toBe(100);

      const branchSource = execFileSync("git", ["show", "livingdocs-bootstrap:gadget.go"], { cwd: tmp, encoding: "utf8" });
      expect(branchSource).toContain("// INFERRED by livingdocs bootstrap");
      expect(branchSource).toContain("// @purpose purpose for gadget.go#Widgetize");

      // Check out the bootstrap branch and re-extract -- the inserted comments must round-trip.
      execFileSync("git", ["checkout", "livingdocs-bootstrap"], { cwd: tmp, stdio: ["ignore", "ignore", "ignore"] });
      const nodes = extractRepo(tmp);
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      expect(byId.get("gadget.go#Widgetize:function")?.humanNarrative.purpose).toBe("purpose for gadget.go#Widgetize");
      expect(byId.get("gadget.go#Counter:struct")?.humanNarrative.purpose).toBe("purpose for gadget.go#Counter");

      const source = readFileSync(join(tmp, "gadget.go"), "utf8");
      // Top-level insertions are never indented -- check per line with [ \t], not \s (which spans
      // across the blank line separating declarations and would false-positive on any comment
      // that simply follows a blank line).
      for (const line of source.split("\n")) {
        if (line.includes("//")) expect(line.startsWith("//")).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
