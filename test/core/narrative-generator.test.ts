import { describe, expect, it } from "vitest";
import { generateErrorResolutions, generateNarratives } from "../../src/core/narrative-generator.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";
import type { DocNode } from "../../src/core/types.js";

class RecordingLlmAdapter implements LlmAdapter {
  calls: LlmCompletionRequest[] = [];
  constructor(private readonly responseText: string) {}
  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.calls.push(request);
    return { text: this.responseText };
  }
}

function makeNode(overrides: Partial<DocNode> = {}): DocNode {
  return {
    nodeId: "a.ts#foo:function",
    filePath: "a.ts",
    entityName: "foo",
    entityType: "function",
    contentHash: "h1",
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

describe("generateNarratives", () => {
  it("makes exactly one batched call covering every target, not one call per node", async () => {
    const nodeA = makeNode({ nodeId: "a.ts#foo:function", entityName: "foo" });
    const nodeB = makeNode({ nodeId: "b.ts#bar:function", entityName: "bar", filePath: "b.ts" });
    const llm = new RecordingLlmAdapter(
      JSON.stringify([
        { nodeId: "a.ts#foo:function", rationale: "r1", example: "e1", gotchas: [] },
        { nodeId: "b.ts#bar:function", rationale: "r2", example: "e2", gotchas: ["g1"] },
      ]),
    );

    const changes = [
      { nodeId: nodeA.nodeId, classification: "added" as const, reason: "new node" },
      { nodeId: nodeB.nodeId, classification: "added" as const, reason: "new node" },
    ];

    const result = await generateNarratives(llm, [nodeA, nodeB], { nodes: [], edges: [] }, changes);

    expect(llm.calls).toHaveLength(1);
    const fooResult = result.nodes.find((n) => n.nodeId === "a.ts#foo:function");
    const barResult = result.nodes.find((n) => n.nodeId === "b.ts#bar:function");
    expect(fooResult?.humanNarrative.rationale).toBe("r1");
    expect(barResult?.humanNarrative.gotchas).toEqual(["g1"]);
    expect(fooResult?.confidence["humanNarrative.rationale"]).toBe("inferred");
  });

  it("never sends a call at all when nothing needs generation", async () => {
    const node = makeNode();
    const llm = new RecordingLlmAdapter("[]");
    const changes = [{ nodeId: node.nodeId, classification: "unchanged" as const, reason: "content hash unchanged" }];

    await generateNarratives(llm, [node], { nodes: [node], edges: [] }, changes);
    expect(llm.calls).toHaveLength(0);
  });

  it("only includes the contract facet (signature + purpose) of dependencies, never their body", async () => {
    const dependency = makeNode({
      nodeId: "a.ts#helper:function",
      entityName: "helper",
      agentContract: { signature: "function helper(): void", preconditions: [], postconditions: [], sideEffects: [], errorModes: [], dependencies: [] },
      humanNarrative: { purpose: "helps with stuff", rationale: null, example: null, gotchas: [] },
    });
    const dependent = makeNode({
      nodeId: "a.ts#main:function",
      entityName: "main",
      agentContract: {
        signature: "function main(): void",
        preconditions: [],
        postconditions: [],
        sideEffects: [],
        errorModes: [],
        dependencies: ["a.ts#helper:function"],
      },
    });
    const llm = new RecordingLlmAdapter(JSON.stringify([{ nodeId: "a.ts#main:function", rationale: "r", example: "e", gotchas: [] }]));
    const changes = [{ nodeId: dependent.nodeId, classification: "added" as const, reason: "new node" }];

    await generateNarratives(llm, [dependent, dependency], { nodes: [], edges: [] }, changes);

    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain("function helper(): void");
    expect(prompt).toContain("helps with stuff");
    // The dependency's own body/implementation must never be requested or included -- there is none to leak
    // in this fixture, but the dependency block itself must be exactly signature + purpose, nothing else.
    expect(prompt).not.toContain("return");
  });

  it("patches an existing narrative instead of writing fresh, by including the prior version in the prompt", async () => {
    const node = makeNode({
      nodeId: "a.ts#foo:function",
      agentContract: { signature: "function foo(x: number): number", preconditions: [], postconditions: [], sideEffects: [], errorModes: [], dependencies: [] },
    });
    const previous = makeNode({
      nodeId: "a.ts#foo:function",
      humanNarrative: { purpose: "does foo", rationale: "Old rationale text.", example: "old example", gotchas: ["old gotcha"] },
    });
    const llm = new RecordingLlmAdapter(JSON.stringify([{ nodeId: "a.ts#foo:function", rationale: "new", example: "new", gotchas: [] }]));
    const changes = [{ nodeId: node.nodeId, classification: "contract-affecting" as const, reason: "signature changed" }];

    await generateNarratives(llm, [node], { nodes: [previous], edges: [] }, changes);

    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain("Existing narrative to patch");
    expect(prompt).toContain("Old rationale text.");
  });

  it("writes fresh (no patch instruction) for a brand-new node with no previous version", async () => {
    const node = makeNode();
    const llm = new RecordingLlmAdapter(JSON.stringify([{ nodeId: node.nodeId, rationale: "r", example: "e", gotchas: [] }]));
    const changes = [{ nodeId: node.nodeId, classification: "added" as const, reason: "new node" }];

    await generateNarratives(llm, [node], { nodes: [], edges: [] }, changes);

    expect(llm.calls[0]!.prompt).toContain("No existing narrative -- write fresh.");
  });

  it("carries a cosmetic node's previous narrative forward untouched instead of blanking it", async () => {
    const previous = makeNode({
      humanNarrative: { purpose: "does foo", rationale: "kept rationale", example: "kept example", gotchas: ["kept"] },
      confidence: { "agentContract.signature": "extracted", "humanNarrative.rationale": "inferred", "humanNarrative.example": "inferred", "humanNarrative.gotchas": "inferred" },
    });
    // Freshly re-extracted after a cosmetic edit: mechanical fields only, narrative blank.
    const freshlyExtracted = makeNode({ humanNarrative: { purpose: "does foo (reworded)", rationale: null, example: null, gotchas: [] } });
    const llm = new RecordingLlmAdapter("[]");
    const changes = [{ nodeId: freshlyExtracted.nodeId, classification: "cosmetic" as const, reason: "only prose/body text changed" }];

    const result = await generateNarratives(llm, [freshlyExtracted], { nodes: [previous], edges: [] }, changes);

    expect(llm.calls).toHaveLength(0);
    const merged = result.nodes[0]!;
    expect(merged.humanNarrative.rationale).toBe("kept rationale");
    expect(merged.humanNarrative.purpose).toBe("does foo (reworded)");
    expect(merged.confidence["humanNarrative.rationale"]).toBe("inferred");
  });
});

describe("generateErrorResolutions", () => {
  it("batches every error type into one call", async () => {
    const llm = new RecordingLlmAdapter(
      JSON.stringify([
        { errorType: "FooError", resolution: "fix foo" },
        { errorType: "BarError", resolution: "fix bar" },
      ]),
    );
    const contexts = new Map([
      ["FooError", ["x is invalid"]],
      ["BarError", ["y is missing"]],
    ]);

    const result = await generateErrorResolutions(llm, ["FooError", "BarError"], contexts);

    expect(llm.calls).toHaveLength(1);
    expect(result.resolutions.get("FooError")).toBe("fix foo");
    expect(result.resolutions.get("BarError")).toBe("fix bar");
  });

  it("makes no call at all when there are no error types to resolve", async () => {
    const llm = new RecordingLlmAdapter("[]");
    const result = await generateErrorResolutions(llm, [], new Map());
    expect(llm.calls).toHaveLength(0);
    expect(result.resolutions.size).toBe(0);
  });
});

