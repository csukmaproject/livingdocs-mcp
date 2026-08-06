import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { extractRepo } from "../../src/core/extractor.js";
import { buildEdges } from "../../src/core/doc-graph.js";
import {
  generateGettingStarted,
  generateSystemOverview,
  readPackageMeta,
  readSectionContent,
  replaceSectionContent,
  seedUserGuide,
} from "../../src/core/rollup-engine.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/documented", import.meta.url));

describe("rollup-engine", () => {
  it("generates Section 2 (System Overview) from extracted nodes, zero LLM calls", () => {
    const nodes = extractRepo(FIXTURE_ROOT);
    const graph = { nodes, edges: buildEdges(nodes) };
    const pkg = readPackageMeta(FIXTURE_ROOT);
    const overview = generateSystemOverview(graph, pkg);
    expect(overview).toContain("documented-fixture");
    expect(overview).toContain("Entry point for the fixture checkout module");
    expect(overview).toContain("documented entities across");
  });

  it("generates Section 3 (Getting Started) from package.json, zero LLM calls", () => {
    const pkg = readPackageMeta(FIXTURE_ROOT);
    const gettingStarted = generateGettingStarted(pkg);
    expect(gettingStarted).toContain("npm install documented-fixture");
    expect(gettingStarted).toContain("documented-fixture");
    expect(gettingStarted).toContain("npm run start");
  });
});

describe("rollup-engine: template sections", () => {
  it("seeds the user guide with the project name substituted", () => {
    const pkg = readPackageMeta(FIXTURE_ROOT);
    const seeded = seedUserGuide(pkg);
    expect(seeded).toContain(`# ${pkg.name} — User Guide`);
    expect(seeded).not.toContain("{{project_name}}");
  });

  it("replaces only the targeted section, leaving the rest of the document untouched", () => {
    const pkg = readPackageMeta(FIXTURE_ROOT);
    const original = seedUserGuide(pkg);

    const updated = replaceSectionContent(original, "system-overview", "New overview content.");
    expect(readSectionContent(updated, "system-overview")).toBe("New overview content.");
    expect(readSectionContent(updated, "getting-started")).toBe(readSectionContent(original, "getting-started"));

    const updatedAgain = replaceSectionContent(updated, "getting-started", "New getting started content.");
    expect(readSectionContent(updatedAgain, "system-overview")).toBe("New overview content.");
    expect(readSectionContent(updatedAgain, "getting-started")).toBe("New getting started content.");
  });
});
