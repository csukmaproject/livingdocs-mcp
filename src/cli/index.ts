#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { ApiKeyProvider } from "../core/llm-adapter.js";
import { countDocumentableEntities, loadGraph, scanRepo, syncUserGuide, userGuidePath } from "../core/index.js";
import type { LlmAdapter, NodeChange } from "../core/index.js";

const SECTION_KEYS = ["system-overview", "getting-started", "core-features", "troubleshooting"];

function resolveRepoRoot(repoOption: string): string {
  return resolve(repoOption);
}

function printChanges(changes: NodeChange[]): void {
  for (const change of changes) {
    console.log(`  [${change.classification}] ${change.nodeId} -- ${change.reason}`);
  }
}

/**
 * No MCP host to borrow sampling from out here, so the CLI/CI path falls
 * back to a direct API key (build brief Phase 5) -- and simply skips the
 * LLM-heavy sections 4-5 when none is configured, rather than failing.
 */
function resolveLlmAdapter(): LlmAdapter | undefined {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  return new ApiKeyProvider({ apiKey });
}

function warnIfNoApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("(no ANTHROPIC_API_KEY set -- skipping Core Features / Troubleshooting regeneration)");
  }
}

const program = new Command();
program.name("livingdocs").description("Keeps software documentation in permanent sync with code.").version("0.1.0");

program
  .command("scan")
  .description("Run ast-diff + classify changes. No writes.")
  .option("-r, --repo <path>", "target repo path", ".")
  .action((opts: { repo: string }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    const previousGraph = loadGraph(repoRoot);
    const { changes } = scanRepo(repoRoot, previousGraph);
    const meaningful = changes.filter((c) => c.classification !== "unchanged");

    if (meaningful.length === 0) {
      console.log("No changes since last scan.");
      return;
    }
    console.log(`${meaningful.length} change(s) since last scan:`);
    printChanges(meaningful);
  });

function printCrossCheck(crossCheck: { missingFromTroubleshooting: string[]; orphanedInTroubleshooting: string[] } | undefined): void {
  if (!crossCheck) return;
  for (const errorType of crossCheck.missingFromTroubleshooting) {
    console.log(`  WARNING: error type "${errorType}" has no troubleshooting row`);
  }
  for (const errorType of crossCheck.orphanedInTroubleshooting) {
    console.log(`  WARNING: troubleshooting row "${errorType}" has no matching error in code`);
  }
}

program
  .command("update")
  .description("Regenerate stale nodes/documents.")
  .option("-r, --repo <path>", "target repo path", ".")
  .action(async (opts: { repo: string }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    warnIfNoApiKey();
    const result = await syncUserGuide(repoRoot, { llm: resolveLlmAdapter() });
    const meaningful = result.changes.filter((c) => c.classification !== "unchanged");

    if (meaningful.length === 0 && result.sectionsChanged.length === 0) {
      console.log("Already up to date.");
      return;
    }

    console.log(`Updated ${userGuidePath(repoRoot)}`);
    console.log(`Sections changed: ${result.sectionsChanged.length > 0 ? result.sectionsChanged.join(", ") : "(none)"}`);
    console.log(`Revision row added: ${result.revisionRowAdded}`);
    if (meaningful.length > 0) {
      console.log("Changes:");
      printChanges(meaningful);
    }
    printCrossCheck(result.crossCheck);
  });

program
  .command("generate")
  .description("Force-generate one document type.")
  .argument("<type>", 'document type to generate (only "user-guide" exists as of Phase 5)')
  .option("-r, --repo <path>", "target repo path", ".")
  .action(async (type: string, opts: { repo: string }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    if (type !== "user-guide") {
      console.error(`Document type "${type}" isn't implemented yet -- only "user-guide" exists as of Phase 5.`);
      process.exitCode = 1;
      return;
    }
    warnIfNoApiKey();
    const result = await syncUserGuide(repoRoot, { force: true, llm: resolveLlmAdapter() });
    console.log(`Generated ${userGuidePath(repoRoot)}`);
    printCrossCheck(result.crossCheck);
  });

program
  .command("status")
  .description("Print coverage %, stale nodes, and last sync per section.")
  .option("-r, --repo <path>", "target repo path", ".")
  .action((opts: { repo: string }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    const graph = loadGraph(repoRoot);
    const { changes } = scanRepo(repoRoot, graph);
    const stale = changes.filter((c) => c.classification !== "unchanged");

    const entityNodeCount = graph.nodes.filter((n) => n.entityType !== "module").length;
    const totalDocumentable = countDocumentableEntities(repoRoot);
    const coverage = totalDocumentable === 0 ? 100 : Math.round((entityNodeCount / totalDocumentable) * 100);

    console.log(`Coverage: ${coverage}% (${entityNodeCount}/${totalDocumentable} documentable entities annotated)`);
    console.log(`Stale nodes: ${stale.length === 0 ? "none" : `${stale.length}`}`);
    if (stale.length > 0) printChanges(stale);
    console.log("Last sync per section:");
    for (const key of SECTION_KEYS) {
      console.log(`  ${key}: ${graph.sectionSyncDates?.[key] ?? "never"}`);
    }
  });

program.parseAsync(process.argv);
