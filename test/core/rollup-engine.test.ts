import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { extractRepo } from "../../src/core/extractor.js";
import { buildEdges } from "../../src/core/doc-graph.js";
import {
  filterBusinessAudienceNodes,
  generateAgentContractReference,
  generateBusinessGuide,
  generateGettingStarted,
  generateSrs,
  generateSystemOverview,
  generateTechnicalGuide,
  readPackageMeta,
  readSectionContent,
  renderPrd,
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

describe("rollup-engine: Phase 10 document types", () => {
  const nodes = extractRepo(FIXTURE_ROOT);
  const graph = { nodes, edges: buildEdges(nodes) };

  it("Agent Contract Reference lists every entity's structured contract facet, zero LLM calls", () => {
    const reference = generateAgentContractReference(graph);
    expect(reference).toContain("src/cart.ts#computeTotal:function");
    expect(reference).toContain("function computeTotal(items: number[], discountPercent: number): number");
    expect(reference).toContain("**Preconditions:** items is a non-empty array of positive prices");
    expect(reference).toContain("src/discounts.ts#normalizeDiscountCode:function");
    expect(reference).toContain("**Error modes:** InvalidDiscountError when code fails the format check");
  });

  it("SRS groups contract facets by @requirement tag for traceability", () => {
    const srs = generateSrs(graph);
    const req042Index = srs.indexOf("## REQ-042");
    const req043Index = srs.indexOf("## REQ-043");
    expect(req042Index).toBeGreaterThan(-1);
    expect(req043Index).toBeGreaterThan(-1);
    // normalizeDiscountCode (REQ-042) appears under REQ-042, not REQ-043.
    const normalizeIndex = srs.indexOf("normalizeDiscountCode");
    expect(normalizeIndex).toBeGreaterThan(req042Index);
    expect(normalizeIndex).toBeLessThan(req043Index);
  });

  it("Technical Guide groups narrative facets by file, including the module's own purpose", () => {
    const guide = generateTechnicalGuide(graph);
    expect(guide).toContain("## src/index.ts");
    expect(guide).toContain("Entry point for the fixture checkout module");
    expect(guide).toContain("## src/cart.ts");
    expect(guide).toContain("### computeTotal");
  });

  it("filters to only @audience:business entities for the Business Guide", () => {
    const businessNodes = filterBusinessAudienceNodes(graph);
    const names = businessNodes.map((n) => n.entityName);
    expect(names).toContain("normalizeDiscountCode"); // tagged audience:business in the fixture
    expect(names).not.toContain("computeTotal"); // tagged audience:technical only
  });

  it("Business Guide falls back to the technical narrative when no rewrite was generated", () => {
    const businessNodes = filterBusinessAudienceNodes(graph);
    const guide = generateBusinessGuide(businessNodes, new Map());
    expect(guide).toContain("### normalizeDiscountCode");
    expect(guide).toContain("Validates and normalizes a discount code before applying it.");
  });

  it("Business Guide prefers a rewrite over the technical narrative when one is available", () => {
    const businessNodes = filterBusinessAudienceNodes(graph);
    const node = businessNodes[0]!;
    const guide = generateBusinessGuide(businessNodes, new Map([[node.nodeId, { purpose: "Plain-language purpose.", rationale: "" }]]));
    expect(guide).toContain("Plain-language purpose.");
    expect(guide).not.toContain("Validates and normalizes a discount code before applying it.");
  });

  it("renderPrd renders one entry per synthesized requirement with acceptance criteria", () => {
    const prd = renderPrd([
      { requirementId: "REQ-042", title: "Discount code validation", description: "Ensures codes are well-formed.", acceptanceCriteria: ["Rejects empty codes"] },
    ]);
    expect(prd).toContain("## REQ-042: Discount code validation");
    expect(prd).toContain("Ensures codes are well-formed.");
    expect(prd).toContain("- Rejects empty codes");
  });

  it("every mechanical Phase 10 rollup degrades gracefully on an empty graph", () => {
    const empty = { nodes: [], edges: [] };
    expect(generateAgentContractReference(empty)).toContain("No documented entities");
    expect(generateSrs(empty)).toContain("No documented entities");
    expect(generateTechnicalGuide(empty)).toContain("No documented entities");
    expect(generateBusinessGuide([], new Map())).toContain("No entities tagged");
    expect(renderPrd([])).toContain("No `@requirement`-tagged entities");
  });
});
