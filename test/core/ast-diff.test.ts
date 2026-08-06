import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { extractRepo } from "../../src/core/extractor.js";
import { diffGraph } from "../../src/core/ast-diff.js";
import type { DocGraph, DocNode } from "../../src/core/types.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

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
    humanNarrative: { purpose: "x", rationale: null, example: null, gotchas: [] },
    confidence: {},
    revisionHistory: [],
    tags: [],
    ...overrides,
  };
}

describe("ast-diff", () => {
  it("classifies unchanged, cosmetic, and contract-affecting edits on a real fixture copy", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-diff-"));
    try {
      cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      const before = extractRepo(tmp);
      const previousGraph: DocGraph = { nodes: before, edges: [] };

      const noChangeDiff = diffGraph(previousGraph, extractRepo(tmp));
      expect(noChangeDiff.every((c) => c.classification === "unchanged")).toBe(true);

      const cartPath = join(tmp, "src/cart.ts");
      const original = readFileSync(cartPath, "utf8");

      // Cosmetic: reword the purpose sentence, leave signature/contract alone.
      const cosmeticSource = original.replace(
        "Computes the final cart total after a discount is applied.",
        "Computes the final shopping cart total once a discount is applied.",
      );
      writeFileSync(cartPath, cosmeticSource);
      const cosmeticDiff = diffGraph(previousGraph, extractRepo(tmp));
      expect(cosmeticDiff.find((c) => c.nodeId === "src/cart.ts#computeTotal:function")?.classification).toBe(
        "cosmetic",
      );

      // Contract-affecting: add a new parameter to the signature.
      const contractSource = cosmeticSource.replace(
        "export function computeTotal(items: number[], discountPercent: number): number {",
        "export function computeTotal(items: number[], discountPercent: number, taxRate: number): number {",
      );
      writeFileSync(cartPath, contractSource);
      const contractDiff = diffGraph(previousGraph, extractRepo(tmp));
      expect(contractDiff.find((c) => c.nodeId === "src/cart.ts#computeTotal:function")?.classification).toBe(
        "contract-affecting",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags added and removed nodes", () => {
    const previous: DocGraph = { nodes: [makeNode()], edges: [] };
    const current = [
      makeNode({
        nodeId: "a.ts#bar:function",
        entityName: "bar",
        contentHash: "h2",
        agentContract: {
          signature: "function totallyDifferent(x, y, z)",
          preconditions: [],
          postconditions: [],
          sideEffects: [],
          errorModes: [],
          dependencies: [],
        },
      }),
    ];
    const changes = diffGraph(previous, current);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "a.ts#foo:function", classification: "removed" }),
        expect.objectContaining({ nodeId: "a.ts#bar:function", classification: "added" }),
      ]),
    );
  });
});
