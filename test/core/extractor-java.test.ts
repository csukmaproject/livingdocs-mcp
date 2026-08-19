import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { countDocumentableEntities, extractRepo, listUndocumentedEntities } from "../../src/core/extractor.js";
import { mineTestReferences, runBootstrap } from "../../src/core/bootstrap.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";

const DOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/documented-java", import.meta.url));
const UNDOCUMENTED_ROOT = fileURLToPath(new URL("../fixtures/undocumented-java", import.meta.url));
const SERVICE_PATH = "src/main/java/fixture/Service.java";
const CALCULATOR_PATH = "src/main/java/fixture/Calculator.java";

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

describe("Java extraction", () => {
  it("extracts class/interface/enum nodes documented with Javadoc, distinguishing block_comment from line_comment", () => {
    const nodes = extractRepo(DOCUMENTED_ROOT);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    const service = byId.get(`${SERVICE_PATH}#Service:class`);
    expect(service).toBeDefined();
    expect(service?.humanNarrative.purpose).toBe("Fixture service demonstrating Java extraction.");
    expect(service?.tags).toContain("requirement:REQ-200");
    expect(service?.agentContract.preconditions).toEqual(["a and b are finite ints"]);

    const shape = byId.get(`${SERVICE_PATH}#Shape:interface`);
    expect(shape).toBeDefined();
    expect(shape?.entityType).toBe("interface");

    const status = byId.get(`${SERVICE_PATH}#Status:enum`);
    expect(status).toBeDefined();
    expect(status?.entityType).toBe("enum");

    // Preceded only by a plain `//` line comment (line_comment, not block_comment) -- must not count as documented.
    expect(byId.has(`${SERVICE_PATH}#Widget:class`)).toBe(false);
    // No comment at all.
    expect(byId.has(`${SERVICE_PATH}#Gadget:class`)).toBe(false);
  });

  it("counts every recognized top-level declaration, documented or not", () => {
    expect(countDocumentableEntities(DOCUMENTED_ROOT)).toBe(5); // Service, Shape, Status, Widget, Gadget
    const documented = extractRepo(DOCUMENTED_ROOT).filter((n) => n.entityType !== "module").length;
    expect(documented).toBe(3);
  });

  it("lists exactly the undocumented declarations", () => {
    const entities = listUndocumentedEntities(DOCUMENTED_ROOT);
    expect(entities.map((e) => e.entityName).sort()).toEqual(["Gadget", "Widget"]);
  });
});

describe("Java bootstrap round-trip", () => {
  it("mines the *Test.java file as a test reference", () => {
    const entities = listUndocumentedEntities(UNDOCUMENTED_ROOT);
    const refs = mineTestReferences(UNDOCUMENTED_ROOT, entities);
    expect(refs.get(`${CALCULATOR_PATH}#Calculator`)).toEqual(["src/test/java/fixture/CalculatorTest.java"]);
    expect(refs.has(`${CALCULATOR_PATH}#Greeter`)).toBe(false);
  });

  it("writes syntactically valid Javadoc comments that extractRepo can then read back", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-java-bootstrap-"));
    try {
      cpSync(UNDOCUMENTED_ROOT, tmp, { recursive: true });
      initGitRepo(tmp);

      const result = await runBootstrap(tmp, { llm: new FakeSynthesisLlm(), seed: null });
      expect(result.coverageAfter).toBe(100);

      const branchSource = execFileSync("git", ["show", `livingdocs-bootstrap:${CALCULATOR_PATH}`], { cwd: tmp, encoding: "utf8" });
      expect(branchSource).toContain("INFERRED by livingdocs bootstrap");
      expect(branchSource).toContain(`@purpose purpose for ${CALCULATOR_PATH}#Calculator`);
      expect(branchSource.startsWith("package") || branchSource.includes("/**")).toBe(true);

      execFileSync("git", ["checkout", "livingdocs-bootstrap"], { cwd: tmp, stdio: ["ignore", "ignore", "ignore"] });
      const nodes = extractRepo(tmp);
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      expect(byId.get(`${CALCULATOR_PATH}#Calculator:class`)?.humanNarrative.purpose).toBe(`purpose for ${CALCULATOR_PATH}#Calculator`);

      const source = readFileSync(join(tmp, CALCULATOR_PATH), "utf8");
      expect(source).toContain("/**");
      expect(source).toContain("*/");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
