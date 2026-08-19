import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/core/index.js";

describe("scaffold", () => {
  it("exposes a core version", () => {
    expect(CORE_VERSION).toBe("1.1.1");
  });
});
