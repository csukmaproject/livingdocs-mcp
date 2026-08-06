import { describe, expect, it } from "vitest";
import { computeContentHash, isStale } from "../../src/core/hash-store.js";

describe("hash-store", () => {
  it("is deterministic for identical text", () => {
    expect(computeContentHash("abc")).toBe(computeContentHash("abc"));
  });

  it("differs for different text", () => {
    expect(computeContentHash("abc")).not.toBe(computeContentHash("abd"));
  });

  it("treats a missing previous hash as stale", () => {
    expect(isStale(undefined, "anything")).toBe(true);
  });

  it("detects staleness only on a real content change", () => {
    const hash = computeContentHash("const x = 1;");
    expect(isStale(hash, "const x = 1;")).toBe(false);
    expect(isStale(hash, "const x = 2;")).toBe(true);
  });
});
