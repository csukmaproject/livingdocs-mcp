import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { countDocumentableEntities, extractRepo, listUndocumentedEntities } from "../../src/core/extractor.js";
import { mineTestReferences, runBootstrap } from "../../src/core/bootstrap.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";

const DOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/documented-python", import.meta.url));
const UNDOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/undocumented-python", import.meta.url));

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

describe("Python extraction", () => {
  it("extracts function/class docstrings, including a decorated function, but not a plain # comment", () => {
    const nodes = extractRepo(DOCUMENTED_ROOT);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    const add = byId.get("pkg/service.py#add:function");
    expect(add).toBeDefined();
    expect(add?.humanNarrative.purpose).toBe("Adds two integers together.");
    expect(add?.tags).toContain("requirement:REQ-300");
    expect(add?.agentContract.preconditions).toEqual(["a and b are numbers"]);
    expect(add?.agentContract.postconditions).toEqual(["returns a + b"]);

    const widget = byId.get("pkg/service.py#Widget:class");
    expect(widget).toBeDefined();
    expect(widget?.humanNarrative.purpose).toBe("A named widget with a value.");

    // @dataclass/@app.route-style decorators wrap the definition in decorated_definition -- must still unwrap.
    const cached = byId.get("pkg/service.py#cached_double:function");
    expect(cached).toBeDefined();
    expect(cached?.humanNarrative.purpose).toBe("Returns n doubled, cached for repeat calls.");

    // A plain `#` comment is not a docstring -- subtract must be undocumented.
    expect(byId.has("pkg/service.py#subtract:function")).toBe(false);
    // A `pass`-only body has no docstring.
    expect(byId.has("pkg/service.py#Gadget:class")).toBe(false);

    const moduleNode = byId.get("pkg/service.py#module");
    expect(moduleNode).toBeDefined();
    expect(moduleNode?.humanNarrative.purpose).toBe("Fixture package covering Python's documentable declaration shapes.");
  });

  it("counts every top-level function/class, documented or not", () => {
    expect(countDocumentableEntities(DOCUMENTED_ROOT)).toBe(5); // add, subtract, Widget, cached_double, Gadget
    const documented = extractRepo(DOCUMENTED_ROOT).filter((n) => n.entityType !== "module").length;
    expect(documented).toBe(3);
  });

  it("lists exactly the undocumented declarations", () => {
    const entities = listUndocumentedEntities(DOCUMENTED_ROOT);
    expect(entities.map((e) => e.entityName).sort()).toEqual(["Gadget", "subtract"]);
  });
});

describe("Python bootstrap round-trip", () => {
  it("mines the test_*.py file as a test reference, matched by basename not full path", () => {
    const entities = listUndocumentedEntities(UNDOCUMENTED_ROOT);
    const refs = mineTestReferences(UNDOCUMENTED_ROOT, entities);
    expect(refs.get("pkg/calc.py#multiply")).toEqual(["tests/test_calc.py"]);
  });

  it("inserts a correctly-indented docstring as the new first statement, valid enough for extractRepo to read back", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-py-bootstrap-"));
    try {
      cpSync(UNDOCUMENTED_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const result = await runBootstrap(tmp, { llm: new FakeSynthesisLlm(), seed: null });
      expect(result.coverageAfter).toBe(100);

      const branchSource = execFileSync("git", ["show", "livingdocs-bootstrap:pkg/calc.py"], { cwd: tmp, encoding: "utf8" });
      expect(branchSource).toContain('    """INFERRED by livingdocs bootstrap');
      expect(branchSource).toContain("    @purpose purpose for pkg/calc.py#multiply");
      // The original first statement keeps its own original indentation on its own line.
      expect(branchSource).toMatch(/"""\n {4}return a \* b/);
      // Greeter's docstring lands before its nested `greet` method, indented one level to match the class body.
      expect(branchSource).toMatch(/class Greeter:\n {4}"""INFERRED/);

      execFileSync("git", ["checkout", "livingdocs-bootstrap"], { cwd: tmp, stdio: ["ignore", "ignore", "ignore"] });
      const nodes = extractRepo(tmp);
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      expect(byId.get("pkg/calc.py#multiply:function")?.humanNarrative.purpose).toBe("purpose for pkg/calc.py#multiply");
      expect(byId.get("pkg/calc.py#Greeter:class")?.humanNarrative.purpose).toBe("purpose for pkg/calc.py#Greeter");

      // Round-trip must not corrupt indentation: python -c compileall is unavailable in CI sandboxes, so
      // assert structurally instead -- every non-blank line inside the inserted docstrings is indented.
      const source = readFileSync(join(tmp, "pkg/calc.py"), "utf8");
      for (const line of source.split("\n").slice(0, 8)) {
        if (line.trim() === "" || line.startsWith("def ") || line.startsWith("class ")) continue;
        expect(line.startsWith("    ")).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
