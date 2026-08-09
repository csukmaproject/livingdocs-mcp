import { describe, expect, it } from "vitest";
import { slugify } from "../src/slug.js";

describe("slugify", () => {
  it("lowercases and hyphenates a title", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips leading and trailing punctuation", () => {
    expect(slugify("  --Hello World!--  ")).toBe("hello-world");
  });
});
