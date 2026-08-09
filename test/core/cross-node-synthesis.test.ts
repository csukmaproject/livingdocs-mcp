import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildEdges } from "../../src/core/doc-graph.js";
import { extractRepo } from "../../src/core/extractor.js";
import { synthesizeBusinessRewrites, synthesizePrdRequirements } from "../../src/core/cross-node-synthesis.js";
import { filterBusinessAudienceNodes } from "../../src/core/rollup-engine.js";
import type { LlmAdapter, LlmCompletionRequest, LlmCompletionResult } from "../../src/core/llm-adapter.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

function extractPromptLabels(prompt: string): string[] {
  return [...prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
}

class RecordingLlmAdapter implements LlmAdapter {
  calls: LlmCompletionRequest[] = [];
  constructor(private readonly buildResponse: (labels: string[]) => unknown[]) {}
  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.calls.push(request);
    return { text: JSON.stringify(this.buildResponse(extractPromptLabels(request.prompt))) };
  }
}

describe("synthesizePrdRequirements", () => {
  it("batches every requirement into one call, scoped to only @requirement-tagged nodes", async () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    const graph = { nodes, edges: buildEdges(nodes) };
    const llm = new RecordingLlmAdapter((labels) =>
      labels.map((requirementId) => ({
        requirementId,
        title: `title for ${requirementId}`,
        description: `description for ${requirementId}`,
        acceptanceCriteria: [`criterion for ${requirementId}`],
      })),
    );

    const requirements = await synthesizePrdRequirements(llm, graph);

    expect(llm.calls).toHaveLength(1);
    expect(extractPromptLabels(llm.calls[0]!.prompt).sort()).toEqual(["REQ-042", "REQ-043"]);
    expect(requirements.find((r) => r.requirementId === "REQ-042")?.title).toBe("title for REQ-042");
    expect(requirements.find((r) => r.requirementId === "REQ-043")?.title).toBe("title for REQ-043");
  });

  it("scopes each requirement's context to only the entities that carry that tag", async () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    const graph = { nodes, edges: buildEdges(nodes) };
    const llm = new RecordingLlmAdapter(() => []);

    await synthesizePrdRequirements(llm, graph);

    // Extract each "### REQ-xxx" block's own text (up to the next "### " or
    // end of prompt) without assuming which requirement comes first.
    const prompt = llm.calls[0]!.prompt;
    const blocks = new Map<string, string>();
    for (const match of prompt.matchAll(/### (REQ-\d+)\n([\s\S]*?)(?=\n### REQ-|$)/g)) {
      blocks.set(match[1]!, match[2]!);
    }

    expect(blocks.get("REQ-042")).toContain("normalizeDiscountCode");
    expect(blocks.get("REQ-042")).not.toContain("computeTotal");
    expect(blocks.get("REQ-043")).toContain("computeTotal");
    expect(blocks.get("REQ-043")).not.toContain("normalizeDiscountCode");
  });

  it("makes no call at all when there are no @requirement-tagged nodes", async () => {
    const llm = new RecordingLlmAdapter(() => []);
    const result = await synthesizePrdRequirements(llm, { nodes: [], edges: [] });
    expect(llm.calls).toHaveLength(0);
    expect(result).toEqual([]);
  });
});

describe("synthesizeBusinessRewrites", () => {
  it("batches every @audience:business node into one call", async () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    const graph = { nodes, edges: buildEdges(nodes) };
    const businessNodes = filterBusinessAudienceNodes(graph);
    const llm = new RecordingLlmAdapter((labels) => labels.map((nodeId) => ({ nodeId, purpose: `plain: ${nodeId}`, rationale: "" })));

    const rewrites = await synthesizeBusinessRewrites(llm, businessNodes);

    expect(llm.calls).toHaveLength(1);
    expect(businessNodes.length).toBeGreaterThan(0);
    const node = businessNodes[0]!;
    expect(rewrites.get(node.nodeId)?.purpose).toBe(`plain: ${node.nodeId}`);
  });

  it("makes no call at all when there are no business-audience nodes", async () => {
    const llm = new RecordingLlmAdapter(() => []);
    const rewrites = await synthesizeBusinessRewrites(llm, []);
    expect(llm.calls).toHaveLength(0);
    expect(rewrites.size).toBe(0);
  });
});
