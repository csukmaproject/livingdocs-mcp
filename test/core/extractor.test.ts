import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { countDocumentableEntities, extractRepo } from "../../src/core/extractor.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

describe("extractor", () => {
  it("extracts entity and module nodes with the expected shape", () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    const normalize = byId.get("src/discounts.ts#normalizeDiscountCode:function");
    expect(normalize).toBeDefined();
    expect(normalize?.entityType).toBe("function");
    expect(normalize?.humanNarrative.purpose).toContain("Validates and normalizes");
    expect(normalize?.tags).toEqual(
      expect.arrayContaining(["requirement:REQ-042", "audience:technical", "audience:business"]),
    );
    expect(normalize?.agentContract.preconditions).toEqual(["code is non-empty string"]);
    expect(normalize?.agentContract.postconditions).toEqual(["returns normalized code"]);
    expect(normalize?.agentContract.errorModes).toEqual([
      { errorType: "InvalidDiscountError", condition: "code fails the format check" },
    ]);
    expect(normalize?.agentContract.sideEffects).toEqual([]);
    expect(normalize?.confidence["humanNarrative.purpose"]).toBe("extracted");

    // InvalidDiscountError has no doc comment of its own, so no node for it.
    expect(byId.has("src/discounts.ts#InvalidDiscountError:class")).toBe(false);

    const cart = byId.get("src/cart.ts#computeTotal:function");
    expect(cart).toBeDefined();
    expect(cart?.agentContract.preconditions).toEqual(["items is a non-empty array of positive prices"]);

    const moduleNode = byId.get("src/index.ts#module");
    expect(moduleNode).toBeDefined();
    expect(moduleNode?.entityType).toBe("module");
    expect(moduleNode?.humanNarrative.purpose).toContain("Entry point for the fixture checkout module");
  });

  it("produces zero LLM-derived fields -- everything traces back to an annotation", () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      for (const value of Object.values(node.confidence)) {
        expect(value).toBe("extracted");
      }
    }
  });
});

describe("countDocumentableEntities", () => {
  it("counts declarations with or without a doc comment, unlike extractRepo", () => {
    // The fixture has 3 documentable declarations (normalizeDiscountCode,
    // InvalidDiscountError, computeTotal) but InvalidDiscountError has no
    // doc comment, so extractRepo only produces 2 entity nodes for it.
    const total = countDocumentableEntities(FIXTURE_ROOT);
    const entityNodes = extractRepo(FIXTURE_ROOT).filter((n) => n.entityType !== "module");
    expect(total).toBe(3);
    expect(entityNodes).toHaveLength(2);
  });
});
