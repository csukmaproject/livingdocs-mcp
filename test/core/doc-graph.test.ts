import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEdges, getNode, loadGraph, saveGraph, upsertNode } from "../../src/core/doc-graph.js";
import type { DocGraph, DocNode } from "../../src/core/types.js";

function makeNode(overrides: Partial<DocNode> = {}): DocNode {
  return {
    nodeId: "a.ts#foo:function",
    filePath: "a.ts",
    entityName: "foo",
    entityType: "function",
    contentHash: "hash1",
    agentContract: {
      signature: "function foo()",
      preconditions: [],
      postconditions: [],
      sideEffects: [],
      errorModes: [],
      dependencies: [],
    },
    humanNarrative: { purpose: "does foo", rationale: null, example: null, gotchas: [] },
    confidence: {},
    revisionHistory: [],
    tags: [],
    ...overrides,
  };
}

describe("doc-graph", () => {
  it("returns an empty graph when no file exists yet", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-"));
    try {
      expect(loadGraph(tmp)).toEqual({ nodes: [], edges: [] });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("round-trips a saved graph", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-"));
    try {
      const graph: DocGraph = { nodes: [makeNode()], edges: [] };
      saveGraph(tmp, graph);
      expect(loadGraph(tmp)).toEqual(graph);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("upserts by nodeId instead of duplicating", () => {
    const graph: DocGraph = { nodes: [makeNode()], edges: [] };
    upsertNode(graph, makeNode({ contentHash: "hash2" }));
    expect(graph.nodes).toHaveLength(1);
    expect(getNode(graph, "a.ts#foo:function")?.contentHash).toBe("hash2");

    upsertNode(graph, makeNode({ nodeId: "b.ts#bar:function", entityName: "bar" }));
    expect(graph.nodes).toHaveLength(2);
  });

  it("builds edges only for dependencies present in the graph", () => {
    const caller = makeNode({
      nodeId: "a.ts#caller:function",
      entityName: "caller",
      agentContract: {
        signature: "",
        preconditions: [],
        postconditions: [],
        sideEffects: [],
        errorModes: [],
        dependencies: ["a.ts#foo:function", "missing.ts#ghost:function"],
      },
    });
    const edges = buildEdges([makeNode(), caller]);
    expect(edges).toEqual([{ from: "a.ts#caller:function", to: "a.ts#foo:function" }]);
  });
});
