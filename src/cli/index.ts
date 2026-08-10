#!/usr/bin/env node
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
  return new ApiKeyProvider({ apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL });
}

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
