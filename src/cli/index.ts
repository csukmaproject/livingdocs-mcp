#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { countDocumentableEntities, loadGraph, scanRepo, syncUserGuide, userGuidePath } from "../core/index.js";
import type { NodeChange } from "../core/index.js";

const SECTION_KEYS = ["system-overview", "getting-started"];

function resolveRepoRoot(repoOption: string): string {
  return resolve(repoOption);
}

function printChanges(changes: NodeChange[]): void {
  for (const change of changes) {
    console.log(`  [${change.classification}] ${change.nodeId} -- ${change.reason}`);
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

program
  .command("update")
  .description("Regenerate stale nodes/documents.")
  .option("-r, --repo <path>", "target repo path", ".")
  .action((opts: { repo: string }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    const result = syncUserGuide(repoRoot);
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
  });

program
  .command("generate")
  .description("Force-generate one document type.")
  .argument("<type>", 'document type to generate (only "user-guide" exists as of Phase 5)')
  .option("-r, --repo <path>", "target repo path", ".")
  .action((type: string, opts: { repo: string }) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    if (type !== "user-guide") {
      console.error(`Document type "${type}" isn't implemented yet -- only "user-guide" exists as of Phase 5.`);
      process.exitCode = 1;
      return;
    }
    syncUserGuide(repoRoot, { force: true });
    console.log(`Generated ${userGuidePath(repoRoot)}`);
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
