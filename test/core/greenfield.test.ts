import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { countDocumentableEntities, extractRepo, listUndocumentedEntities } from "../../src/core/extractor.js";
import { buildEdges } from "../../src/core/doc-graph.js";
import { generateAgentContractReference, generateSrs } from "../../src/core/rollup-engine.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/greenfield", import.meta.url));

// Unlike the undocumented fixture (Phase 9, needs bootstrap) or the
// documented fixture (Phase 2+, partially annotated), greenfield
// represents docgen-plugin-plan.md Section 3's "new project" case:
// annotations written alongside code from day one, so extraction should
// be deterministic and exact-match here, with zero bootstrap gap.
describe("greenfield fixture", () => {
  it("extracts exactly the annotated entities, exact-match", () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    expect([...byId.keys()].sort()).toEqual([
      "src/greeting.ts#BlankNameError:class",
      "src/greeting.ts#buildGreeting:function",
      "src/index.ts#module",
    ]);

    const buildGreeting = byId.get("src/greeting.ts#buildGreeting:function")!;
    expect(buildGreeting.entityType).toBe("function");
    expect(buildGreeting.agentContract).toEqual({
      signature: "function buildGreeting(name: string): string",
      preconditions: ["name is a non-empty, non-blank string"],
      postconditions: ['returns "Hello, <name>!" with the name trimmed'],
      sideEffects: [],
      errorModes: [{ errorType: "BlankNameError", condition: "name is empty or all whitespace" }],
      dependencies: [],
    });
    expect(buildGreeting.tags).toEqual(["requirement:REQ-001", "audience:technical", "audience:business"]);
    expect(buildGreeting.confidence).toEqual({
      "agentContract.signature": "extracted",
      "agentContract.preconditions": "extracted",
      "agentContract.postconditions": "extracted",
      "agentContract.errorModes": "extracted",
      "humanNarrative.purpose": "extracted",
    });
  });

  it("has zero bootstrap gap -- every documentable entity is already annotated", () => {
    expect(listUndocumentedEntities(FIXTURE_ROOT)).toEqual([]);

    const total = countDocumentableEntities(FIXTURE_ROOT);
    const documented = extractRepo(FIXTURE_ROOT).filter((n) => n.entityType !== "module").length;
    expect(documented).toBe(total);
    expect(Math.round((documented / total) * 100)).toBe(100);
  });

  it("mechanical rollups (Agent Contract Reference, SRS) render structurally without any LLM call", () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    const graph = { nodes, edges: buildEdges(nodes) };

    const reference = generateAgentContractReference(graph);
    expect(reference).toContain("src/greeting.ts#buildGreeting:function");
    expect(reference).toContain("**Error modes:** BlankNameError when name is empty or all whitespace");

    const srs = generateSrs(graph);
    expect(srs).toContain("## REQ-001");
    expect(srs).toContain("### buildGreeting");
    expect(srs).not.toContain("## Unclassified"); // nothing here lacks a @requirement tag
  });
});
