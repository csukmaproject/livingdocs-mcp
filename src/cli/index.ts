#!/usr/bin/env node
/**
 * @purpose CLI entry point for livingdocs-mcp: exposes the scan, update, generate, status, and bootstrap commands (via commander) so the doc-sync pipeline can run outside of an MCP host, falling back to a direct Anthropic API key for LLM calls.
 * @audience technical
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { ApiKeyProvider } from "../core/llm-adapter.js";
import {
  countDocumentableEntities,
  generateDocument,
  loadGraph,
  loadSeed,
  runBootstrap,
  saveSeed,
  scanRepo,
  syncUserGuide,
  userGuidePath,
  GENERATED_DOCUMENT_TYPES,
  SEED_QUESTIONS,
} from "../core/index.js";
import type { BootstrapSeed, LlmAdapter, NodeChange } from "../core/index.js";

const SECTION_KEYS = ["system-overview", "getting-started", "core-features", "troubleshooting"];

/**
 * @purpose Normalizes the --repo CLI option into an absolute path so every downstream call works against a consistent repo root.
 * @contract pre: repoOption is a path string (relative or absolute).
 *   post: returns the absolute path resolved from repoOption.
 *   side-effects: none.
 * @audience technical
 */
function resolveRepoRoot(repoOption: string): string {
  return resolve(repoOption);
}

/**
 * @purpose Prints one human-readable line per node change (classification, nodeId, reason) for CLI output.
 * @contract post: writes one formatted line per change to stdout; returns nothing.
 *   side-effects: writes to stdout via console.log.
 * @audience technical
 */
function printChanges(changes: NodeChange[]): void {
  for (const change of changes) {
    console.log(`  [${change.classification}] ${change.nodeId} -- ${change.reason}`);
  }
}

/**
 * @purpose Builds a direct-API-key LLM adapter for the CLI/CI path, since there's no MCP host out here to borrow sampling from.
 * @contract post: returns an ApiKeyProvider configured from ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL, or undefined when no API key is set (callers then skip the LLM-heavy sections instead of failing).
 *   side-effects: none.
 * @audience technical
 */
function resolveLlmAdapter(): LlmAdapter | undefined {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  return new ApiKeyProvider({ apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL });
}

/**
 * @purpose Warns the user on stdout when no Anthropic API key is configured, since LLM-heavy regeneration will be skipped.
 * @contract post: logs a warning message when ANTHROPIC_API_KEY is unset; does nothing otherwise.
 *   side-effects: writes to stdout via console.log when no API key is set.
 * @audience technical
 */
function warnIfNoApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("(no ANTHROPIC_API_KEY set -- skipping Core Features / Troubleshooting regeneration)");
  }
}

const program = new Command();
program.name("livingdocs").description("Keeps software documentation in permanent sync with code.").version("1.0.0");

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

/**
 * @purpose Prints warnings when thrown error types and the troubleshooting doc's rows have drifted out of sync in either direction.
 * @contract pre: crossCheck may be undefined, in which case this is a no-op.
 *   post: logs one warning line per error type missing a troubleshooting row and per troubleshooting row with no matching error.
 *   side-effects: writes to stdout via console.log.
 * @audience technical
 */
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
  .description(`Force-generate one document type: user-guide, ${GENERATED_DOCUMENT_TYPES.join(", ")}.`)
  .argument("<type>", "document type to generate")
  .option("-r, --repo <path>", "target repo path", ".")
  .action(async (type: string, opts: { repo: string }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    if (["user-guide", "prd", "business-guide"].includes(type)) warnIfNoApiKey();
    const result = await generateDocument(repoRoot, type, resolveLlmAdapter());
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Generated ${result.outputPath}`);
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

/**
 * @purpose Loads a previously saved bootstrap seed, or, interactively on a TTY, prompts once for the business-context answers used to seed generated documentation.
 * @contract pre: none -- works whether or not a seed already exists.
 *   post: returns the existing seed unless reset is true; returns null when stdin isn't a TTY (no prompting); otherwise asks each SEED_QUESTIONS entry, persists the answers via saveSeed, and returns the new seed.
 *   side-effects: reads from stdin and writes prompts/messages to stdout when run interactively; persists the seed to disk via saveSeed.
 * @audience technical
 */
async function collectSeed(repoRoot: string, reset: boolean): Promise<BootstrapSeed | null> {
  if (!reset) {
    const existing = loadSeed(repoRoot);
    if (existing) return existing;
  }

  if (!process.stdin.isTTY) {
    console.log("(no TTY -- skipping the business-context questions; annotations will be inferred from code/test/git signals only)");
    return null;
  }

  console.log("A few one-time questions to seed business rationale (never re-asked unless --reset-seed):\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers: string[] = [];
  try {
    for (const question of SEED_QUESTIONS) {
      answers.push(await rl.question(`${question}\n> `));
    }
  } finally {
    rl.close();
  }

  const seed: BootstrapSeed = { questions: [...SEED_QUESTIONS], answers, answeredAt: new Date().toISOString() };
  saveSeed(repoRoot, seed);
  return seed;
}

program
  .command("bootstrap")
  .description("Run the signal-source pipeline on an undocumented repo and propose annotations via a PR.")
  .option("-r, --repo <path>", "target repo path", ".")
  .option("--reset-seed", "re-ask the business-context questions even if already answered", false)
  .action(async (opts: { repo: string; resetSeed: boolean }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    const llm = resolveLlmAdapter();
    if (!llm) {
      console.error("ANTHROPIC_API_KEY is required for bootstrap (no MCP host to borrow sampling from out here).");
      process.exitCode = 1;
      return;
    }

    const seed = await collectSeed(repoRoot, opts.resetSeed);
    const result = await runBootstrap(repoRoot, { llm, seed });

    if (result.filesChanged.length === 0) {
      console.log("Nothing to bootstrap -- every documentable entity already has a doc comment.");
      return;
    }

    console.log(`Coverage: ${result.coverageBefore}% -> ${result.coverageAfter}%`);
    console.log(
      `Proposed annotations for ${result.proposedEntities.length} entit${result.proposedEntities.length === 1 ? "y" : "ies"} across ${result.filesChanged.length} file(s), all marked INFERRED:`,
    );
    for (const key of result.proposedEntities) console.log(`  - ${key}`);
    console.log(`\nCommitted to branch "${result.branchName}" (your checkout is back on the original branch).`);
    if (result.prUrl) {
      console.log(`Pull request opened: ${result.prUrl}`);
    } else if (result.pushed) {
      console.log("Branch pushed to origin -- open a PR yourself (gh not available/authenticated here).");
    } else {
      console.log(`No remote configured -- push it yourself: git push -u origin ${result.branchName}`);
    }
  });

program.parseAsync(process.argv);
