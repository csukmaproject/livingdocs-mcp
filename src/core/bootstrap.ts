import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { countDocumentableEntities, extractRepo, insertAnnotationComments, listUndocumentedEntities, walkSourceFiles } from "./extractor.js";
import { parseJsonArrayResponse } from "./narrative-generator.js";
import type { LlmAdapter } from "./llm-adapter.js";
import type { UndocumentedEntity } from "./extractor.js";

// docgen-plugin-plan.md Section 3: collected once, never re-asked --
// business rationale has no trace in code, so the LLM shouldn't be asked
// to invent plausible-sounding justifications for it.
export const SEED_QUESTIONS: readonly string[] = [
  "In one or two sentences, what business problem does this codebase solve?",
  "Who are the primary users or consumers of this system?",
  "What is the single most important invariant or business rule that must never be violated?",
  "Are there any regulatory, compliance, or security constraints that shape this code?",
  "What is the most common mistake new contributors make when changing this code?",
  "Is there a deprecated or legacy pattern here that new code should avoid following?",
];

export interface BootstrapSeed {
  questions: string[];
  answers: string[];
  answeredAt: string;
}

const SEED_RELATIVE_PATH = ".livingdocs/bootstrap-seed.json";

export function seedPath(repoRoot: string): string {
  return join(repoRoot, SEED_RELATIVE_PATH);
}

export function loadSeed(repoRoot: string): BootstrapSeed | null {
  const path = seedPath(repoRoot);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as BootstrapSeed;
}

export function saveSeed(repoRoot: string, seed: BootstrapSeed): void {
  const path = seedPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$/;

/** Signal source #2 (docgen-plugin-plan.md Section 3): which test files mention an entity by name. */
export function mineTestReferences(repoRoot: string, entities: UndocumentedEntity[]): Map<string, string[]> {
  const testFiles = walkSourceFiles(repoRoot).filter((f) => TEST_FILE_PATTERN.test(f));
  const references = new Map<string, string[]>();
  for (const entity of entities) {
    const key = `${entity.filePath}#${entity.entityName}`;
    const matches: string[] = [];
    for (const absTestFile of testFiles) {
      const relTestFile = relative(repoRoot, absTestFile);
      if (relTestFile === entity.filePath) continue;
      const content = readFileSync(absTestFile, "utf8");
      if (new RegExp(`\\b${escapeRegExp(entity.entityName)}\\b`).test(content)) {
        matches.push(relTestFile);
      }
    }
    if (matches.length > 0) references.set(key, matches);
  }
  return references;
}

/** Signal source #3: files that historically change in the same commit as a given file, most-frequent first. */
export function mineGitCoChange(repoRoot: string): Map<string, string[]> {
  let log: string;
  try {
    log = execFileSync("git", ["log", "--name-only", "--pretty=format:__COMMIT__"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Map();
  }

  const commits = log
    .split("__COMMIT__")
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean));

  const coChangeCounts = new Map<string, Map<string, number>>();
  for (const files of commits) {
    for (const file of files) {
      for (const other of files) {
        if (file === other) continue;
        const counts = coChangeCounts.get(file) ?? new Map<string, number>();
        counts.set(other, (counts.get(other) ?? 0) + 1);
        coChangeCounts.set(file, counts);
      }
    }
  }

  const result = new Map<string, string[]>();
  for (const [file, counts] of coChangeCounts) {
    result.set(
      file,
      [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 5),
    );
  }
  return result;
}

function splitIdentifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2);
}

/** Signal source #4: entities whose names share a significant word fragment (e.g. "rateLimiter" / "RateLimitExceededError" both containing "rate"/"limit"). */
export function clusterByNaming(entities: UndocumentedEntity[]): Map<string, string[]> {
  const wordToKeys = new Map<string, string[]>();
  for (const entity of entities) {
    const key = `${entity.filePath}#${entity.entityName}`;
    for (const word of splitIdentifierWords(entity.entityName)) {
      const keys = wordToKeys.get(word) ?? [];
      keys.push(key);
      wordToKeys.set(word, keys);
    }
  }
  const clusters = new Map<string, string[]>();
  for (const [word, keys] of wordToKeys) {
    if (keys.length > 1) clusters.set(word, keys);
  }
  return clusters;
}

/**
 * Signal source #5 (behavioral probing) is intentionally a no-op.
 * docgen-plugin-plan.md Section 3 describes "run untested code against
 * generated inputs to observe real behavior" -- executing arbitrary code
 * from a target repo is a real code-execution safety concern, not
 * something to build casually as a documentation feature. Left as an
 * explicit, documented stub rather than silently omitted from the
 * pipeline's priority order.
 */
export function probeBehavior(): Map<string, string[]> {
  return new Map();
}

export interface ProposedAnnotation {
  key: string;
  purpose: string;
  contractPre: string[];
  contractPost: string[];
  contractSideEffects: string;
  audience: string[];
}

interface SynthesisTarget {
  entity: UndocumentedEntity;
  testReferences: string[];
  coChangedFiles: string[];
  namingCluster: string[];
}

function formatSynthesisBlock(target: SynthesisTarget): string {
  const { entity, testReferences, coChangedFiles, namingCluster } = target;
  const key = `${entity.filePath}#${entity.entityName}`;
  return [
    `### ${key}`,
    `Signature: ${entity.signature}`,
    `Referenced by tests: ${testReferences.join(", ") || "(none found)"}`,
    `Files historically changed alongside ${entity.filePath}: ${coChangedFiles.join(", ") || "(none)"}`,
    `Other entities sharing a name fragment: ${namingCluster.filter((k) => k !== key).join(", ") || "(none)"}`,
  ].join("\n");
}

function buildSynthesisPrompt(targets: SynthesisTarget[], seed: BootstrapSeed | null): string {
  const context = seed
    ? `Business context from the project owner:\n${seed.questions.map((q, i) => `${i + 1}. ${q}\n   ${seed.answers[i] ?? "(no answer)"}`).join("\n")}`
    : "No business-context answers were provided -- infer purpose from code/test/git signals only, and keep claims conservative.";
  const instructions =
    'For each entity below, propose documentation. Respond with ONLY a JSON array, one object per entity, each shaped ' +
    'exactly as {"key": string, "purpose": string, "contractPre": string[], "contractPost": string[], ' +
    '"contractSideEffects": string, "audience": string[]}. "key" must be exactly the "### <key>" heading text. ' +
    'audience entries must each be one of: technical, business, agent-only. Keep every field terse. No prose outside the JSON.';
  return `${instructions}\n\n${context}\n\n${targets.map(formatSynthesisBlock).join("\n\n")}`;
}

function parseSynthesisResponse(text: string): ProposedAnnotation[] {
  return parseJsonArrayResponse(text).map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      key: String(item.key ?? ""),
      purpose: String(item.purpose ?? ""),
      contractPre: Array.isArray(item.contractPre) ? item.contractPre.map(String) : [],
      contractPost: Array.isArray(item.contractPost) ? item.contractPost.map(String) : [],
      contractSideEffects: String(item.contractSideEffects ?? "none"),
      audience: Array.isArray(item.audience) ? item.audience.map(String) : ["technical"],
    };
  });
}

/** Renders a proposal into the exact annotation syntax docs/annotation-tags.md defines, with a visible "needs review" marker so inferred content can never be mistaken for human-authored fact. */
export function formatAnnotationComment(proposed: ProposedAnnotation): string {
  const lines = ["/**", " * INFERRED by livingdocs bootstrap -- please review before relying on this.", ` * @purpose ${proposed.purpose}`];
  const clauses: string[] = [];
  if (proposed.contractPre.length > 0) clauses.push(`pre: ${proposed.contractPre.join(". ")}.`);
  if (proposed.contractPost.length > 0) clauses.push(`post: ${proposed.contractPost.join(". ")}.`);
  clauses.push(`side-effects: ${proposed.contractSideEffects || "none"}.`);
  lines.push(` * @contract ${clauses.join(" ")}`);
  lines.push(` * @audience ${proposed.audience.join(", ")}`);
  lines.push(" */");
  return lines.join("\n");
}

function tryGit(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function buildPrBody(filesChanged: string[], entityCount: number): string {
  return [
    "Proposed by `livingdocs bootstrap`.",
    "",
    `${entityCount} entit${entityCount === 1 ? "y" : "ies"} across ${filesChanged.length} file(s) got a documentation annotation proposal, all marked \`INFERRED\` in the comment itself.`,
    "",
    "**Please review before merging** -- this content is a best-effort guess from code structure, tests, git history, and naming, not verified fact.",
    "",
    "Files touched:",
    ...filesChanged.map((f) => `- ${f}`),
  ].join("\n");
}

/**
 * Commits the already-written proposal to a new branch (never the branch
 * the user had checked out -- build brief Phase 9: "opens a PR ... rather
 * than committing directly"), leaving the working tree back on the
 * original branch. Pushes and opens a real PR only if a remote and an
 * authenticated `gh` are actually available; otherwise reports the local
 * branch so the user can push it themselves.
 */
function commitProposalToBranch(
  repoRoot: string,
  filesChanged: string[],
  entityCount: number,
): { branchName: string; pushed: boolean; prUrl: string | null } {
  const originalBranch = tryGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (originalBranch === null || filesChanged.length === 0) {
    return { branchName: "", pushed: false, prUrl: null };
  }

  let branchName = "livingdocs-bootstrap";
  let suffix = 2;
  while (tryGit(repoRoot, ["rev-parse", "--verify", branchName]) !== null) {
    branchName = `livingdocs-bootstrap-${suffix}`;
    suffix++;
  }

  execFileSync("git", ["checkout", "-b", branchName], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["add", ...filesChanged], { cwd: repoRoot });
  execFileSync(
    "git",
    ["commit", "-q", "-m", `docs: bootstrap ${filesChanged.length} file(s), ${entityCount} entit(y/ies) -- INFERRED, needs review`],
    { cwd: repoRoot },
  );
  execFileSync("git", ["checkout", originalBranch], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });

  let pushed = false;
  let prUrl: string | null = null;
  if (tryGit(repoRoot, ["remote", "get-url", "origin"]) !== null) {
    try {
      execFileSync("git", ["push", "-u", "origin", branchName], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
      pushed = true;
      try {
        const output = execFileSync(
          "gh",
          ["pr", "create", "--head", branchName, "--title", "docs: livingdocs bootstrap proposal", "--body", buildPrBody(filesChanged, entityCount)],
          { cwd: repoRoot, encoding: "utf8" },
        );
        prUrl = output.trim().split("\n").pop() ?? null;
      } catch {
        // gh not installed/authenticated -- branch is pushed, user opens the PR themselves.
      }
    } catch {
      // no push access or unreachable remote -- report the local branch only.
    }
  }

  return { branchName, pushed, prUrl };
}

export interface BootstrapOptions {
  llm: LlmAdapter;
  seed: BootstrapSeed | null;
}

export interface BootstrapResult {
  coverageBefore: number;
  coverageAfter: number;
  proposedEntities: string[];
  filesChanged: string[];
  branchName: string;
  pushed: boolean;
  prUrl: string | null;
}

function coveragePercent(repoRoot: string): number {
  const total = countDocumentableEntities(repoRoot);
  if (total === 0) return 100;
  const documented = extractRepo(repoRoot).filter((n) => n.entityType !== "module").length;
  return Math.round((documented / total) * 100);
}

/**
 * Runs the signal-source pipeline in priority order (docgen-plugin-plan.md
 * Section 3: code structure -> tests -> git history -> naming -> behavioral
 * probing -> LLM synthesis), writes proposed annotations into the source
 * files, and commits the proposal to a fresh branch rather than the
 * checked-out one.
 */
export async function runBootstrap(repoRoot: string, options: BootstrapOptions): Promise<BootstrapResult> {
  const coverageBefore = coveragePercent(repoRoot);
  const entities = listUndocumentedEntities(repoRoot);

  if (entities.length === 0) {
    return { coverageBefore, coverageAfter: coverageBefore, proposedEntities: [], filesChanged: [], branchName: "", pushed: false, prUrl: null };
  }

  const testReferences = mineTestReferences(repoRoot, entities);
  const coChange = mineGitCoChange(repoRoot);
  const namingClusters = clusterByNaming(entities);
  probeBehavior(); // signal source #5 -- always a no-op, see probeBehavior's docstring.

  const targets: SynthesisTarget[] = entities.map((entity) => {
    const key = `${entity.filePath}#${entity.entityName}`;
    return {
      entity,
      testReferences: testReferences.get(key) ?? [],
      coChangedFiles: coChange.get(entity.filePath) ?? [],
      namingCluster: [...namingClusters.values()].find((keys) => keys.includes(key)) ?? [],
    };
  });

  const response = await options.llm.complete({ prompt: buildSynthesisPrompt(targets, options.seed), maxTokens: 300 * targets.length });
  const proposalByKey = new Map(parseSynthesisResponse(response.text).map((p) => [p.key, p]));

  const entitiesByFile = new Map<string, UndocumentedEntity[]>();
  for (const entity of entities) {
    const list = entitiesByFile.get(entity.filePath) ?? [];
    list.push(entity);
    entitiesByFile.set(entity.filePath, list);
  }

  const filesChanged: string[] = [];
  for (const [filePath, fileEntities] of entitiesByFile) {
    const absPath = join(repoRoot, filePath);
    const insertions = fileEntities
      .map((entity) => {
        const proposed = proposalByKey.get(`${entity.filePath}#${entity.entityName}`);
        return proposed ? { insertionIndex: entity.insertionIndex, commentBlock: formatAnnotationComment(proposed) } : null;
      })
      .filter((x): x is { insertionIndex: number; commentBlock: string } => x !== null);
    if (insertions.length === 0) continue;
    writeFileSync(absPath, insertAnnotationComments(readFileSync(absPath, "utf8"), insertions), "utf8");
    filesChanged.push(filePath);
  }

  const coverageAfter = coveragePercent(repoRoot);
  const { branchName, pushed, prUrl } = commitProposalToBranch(repoRoot, filesChanged, entities.length);

  return { coverageBefore, coverageAfter, proposedEntities: [...proposalByKey.keys()], filesChanged, branchName, pushed, prUrl };
}
