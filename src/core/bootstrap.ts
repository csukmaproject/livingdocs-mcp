/**
 * @purpose Bootstrap pipeline for undocumented repos: mines code structure, tests, git co-change history, and naming clusters into signals, synthesizes documentation proposals with an LLM, writes them into source files as INFERRED annotations, and optionally commits the result to a fresh branch/PR for review.
 * @audience technical
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { countDocumentableEntities, extractRepo, insertAnnotationComments, listUndocumentedEntities, walkSourceFiles } from "./extractor.js";
import { parseJsonArrayResponse } from "./narrative-generator.js";
import { allTestFilePatterns, adapterFor } from "./languages/registry.js";
import { typescriptAdapter } from "./languages/typescript.js";
import type { ProposedAnnotation } from "./languages/types.js";
import type { LlmAdapter } from "./llm-adapter.js";
import type { UndocumentedEntity } from "./extractor.js";

export type { ProposedAnnotation };

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

/**
 * @purpose Shape of the one-time business-context Q&A (SEED_QUESTIONS plus the project owner's answers) persisted so it is never re-asked.
 * @audience technical
 */
export interface BootstrapSeed {
  questions: string[];
  answers: string[];
  answeredAt: string;
}

const SEED_RELATIVE_PATH = ".livingdocs/bootstrap-seed.json";

/**
 * @purpose Computes the absolute path to the bootstrap seed file for a given repo.
 * @contract pre: repoRoot is an absolute path to the target repo.
 *   post: returns the absolute path to repoRoot/.livingdocs/bootstrap-seed.json.
 *   side-effects: none.
 * @audience technical
 */
export function seedPath(repoRoot: string): string {
  return join(repoRoot, SEED_RELATIVE_PATH);
}

/**
 * @purpose Loads previously saved seed answers from disk, if a seed file already exists for this repo.
 * @contract post: returns the parsed BootstrapSeed when the seed file exists, otherwise null.
 *   throws: SyntaxError when the seed file exists but its contents are not valid JSON.
 *   side-effects: none (only reads the filesystem).
 * @audience technical
 */
export function loadSeed(repoRoot: string): BootstrapSeed | null {
  const path = seedPath(repoRoot);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as BootstrapSeed;
}

/**
 * @purpose Persists the collected seed answers so the seed questions are never re-asked for this repo.
 * @contract post: writes seed as pretty-printed JSON (with trailing newline) to repoRoot/.livingdocs/bootstrap-seed.json.
 *   side-effects: creates the .livingdocs directory if it doesn't exist yet, and creates or overwrites bootstrap-seed.json.
 * @audience technical
 */
export function saveSeed(repoRoot: string, seed: BootstrapSeed): void {
  const path = seedPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
}

/**
 * @purpose Escapes regex metacharacters so an arbitrary string (an entity name) can be safely embedded inside a RegExp pattern.
 * @contract post: returns value with regex-special characters backslash-escaped.
 *   side-effects: none.
 * @audience technical
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @purpose Recognizes a test file by matching its basename (not full path) against every registered LanguageAdapter's testFilePattern -- required because Python's `test_*.py` prefix convention must be checked against the basename, since a prefix anchor tested against an absolute path would never match.
 * @contract post: returns true iff basename(filePath) matches some registered adapter's testFilePattern.
 *   side-effects: none.
 * @audience technical
 */
function isTestFile(filePath: string): boolean {
  const name = basename(filePath);
  return allTestFilePatterns().some((pattern) => pattern.test(name));
}

/**
 * Signal source #2 (docgen-plugin-plan.md Section 3): which test files mention an entity by name.
 *
 * @purpose Finds, for each undocumented entity, which test files reference its name by a whole-word match, as a signal for what the entity is used for.
 * @contract pre: entity.filePath values are relative to repoRoot.
 *   post: returns a map from "filePath#entityName" to the list of relative test-file paths (matching some registered language's test-file convention) whose content mentions that name as a whole word, excluding the entity's own file; entities with no matches are omitted from the map.
 *   side-effects: none (reads test files from disk; writes nothing).
 * @audience technical
 */
export function mineTestReferences(repoRoot: string, entities: UndocumentedEntity[]): Map<string, string[]> {
  const testFiles = walkSourceFiles(repoRoot).filter(isTestFile);
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

/**
 * Signal source #3: files that historically change in the same commit as a given file, most-frequent first.
 *
 * @purpose Mines `git log` history to find, for each file, the other files most frequently changed in the same commit, as a signal of related/coupled code.
 * @contract pre: repoRoot is ideally a git repository with commit history.
 *   post: returns a map from file path to up to 5 other file paths that most often appear in the same commit, sorted by descending co-change count; returns an empty Map if `git log` fails (e.g. not a git repo, or git unavailable).
 *   side-effects: shells out to `git log` (read-only; does not modify repo state).
 * @audience technical
 */
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

/**
 * @purpose Splits a camelCase/snake_case/kebab-case identifier into lowercase word fragments, for naming-similarity clustering.
 * @contract post: returns the lowercase words obtained by splitting on case boundaries and on `_`/`-` separators, discarding fragments of length 2 or less.
 *   side-effects: none.
 * @audience technical
 */
function splitIdentifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2);
}

/**
 * Signal source #4: entities whose names share a significant word fragment
 * (e.g. "rateLimiter" / "RateLimitExceededError" both containing "rate"/"limit").
 *
 * @purpose Clusters undocumented entities whose names share a significant word fragment, so the LLM synthesis pass can be shown likely-related entities.
 * @contract post: returns a map from shared word fragment to the list of entity keys ("filePath#entityName") whose name contains that word, restricted to words shared by more than one entity.
 *   side-effects: none.
 * @audience technical
 */
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
 *
 * @purpose Placeholder for the "behavioral probing" signal source, deliberately left unimplemented since executing arbitrary code from a target repo is a code-execution safety risk, not something to add casually.
 * @contract post: always returns an empty Map.
 *   side-effects: none.
 * @audience technical
 */
export function probeBehavior(): Map<string, string[]> {
  return new Map();
}

/**
 * @purpose Bundles one undocumented entity together with all of its mined signals (test references, co-changed files, naming cluster) as input to synthesis-prompt construction.
 * @audience technical
 */
interface SynthesisTarget {
  entity: UndocumentedEntity;
  testReferences: string[];
  coChangedFiles: string[];
  namingCluster: string[];
}

/**
 * @purpose Renders one SynthesisTarget into the "### <key>" markdown block that gets embedded in the LLM synthesis prompt.
 * @contract pre: entity.filePath and entity.entityName together form the "key" used to match the LLM's response back to this entity.
 *   post: returns a multi-line string describing the entity's signature and its mined signals (test references, co-changed files, naming-cluster peers), substituting "(none found)"/"(none)" placeholders where a signal is empty.
 *   side-effects: none.
 * @audience technical
 */
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

/**
 * @purpose Assembles the full prompt sent to the LLM: business-context Q&A from the seed (or an instruction to infer conservatively when no seed exists), the required JSON response-shape instructions, and one formatted block per target entity.
 * @contract post: returns the complete prompt text, combining instructions, seed context (or its absence), and all targets' synthesis blocks separated by blank lines.
 *   side-effects: none.
 * @audience technical
 */
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

/**
 * @purpose Parses the LLM's raw JSON-array response into typed ProposedAnnotation objects, defaulting any missing or malformed fields so a partially-broken response doesn't crash the pipeline.
 * @contract pre: text is expected to contain a JSON array (optionally wrapped in a markdown code fence), per parseJsonArrayResponse's contract.
 *   post: returns one ProposedAnnotation per parsed array item; missing key/purpose default to "", non-array contractPre/contractPost default to [], missing contractSideEffects defaults to "none", and missing/non-array audience defaults to ["technical"].
 *   throws: SyntaxError when text (after stripping code fences) is not valid JSON; Error ("Expected a JSON array in the model response") when the parsed JSON is not an array.
 *   side-effects: none.
 * @audience technical
 */
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

/**
 * @purpose Renders one ProposedAnnotation into the literal /** *\/ comment text (matching the docs/annotation-tags.md schema) that gets inserted above an entity, always prefixed with an "INFERRED ... please review" marker line, so inferred content can never be mistaken for human-authored fact. Kept as a stable, TS/JS-specific public export for backward compatibility -- multi-language bootstrap now renders through each entity's own LanguageAdapter.formatAnnotation instead (see runBootstrap), since Go/Python/Java each need a different comment/docstring syntax.
 * @contract post: returns a multi-line string: opening "/**", the INFERRED marker line, "@purpose", an "@contract" line whose clauses include "pre:"/"post:" only when the corresponding array is non-empty and always include "side-effects:" (defaulting to "none"), an "@audience" line, and the closing "*\/".
 *   side-effects: none.
 * @audience technical
 */
export function formatAnnotationComment(proposed: ProposedAnnotation): string {
  return typescriptAdapter.formatAnnotation(proposed, "");
}

/**
 * @purpose Runs a git subcommand in repoRoot and returns its trimmed stdout, treating any failure (git missing, non-zero exit, not a repo, etc.) as "no answer" rather than an exception.
 * @contract post: returns trimmed stdout on success, or null if the command fails or git is unavailable.
 *   side-effects: executes the given git subcommand in repoRoot; whether it mutates repo state depends on the args passed by the caller (every call site in this file passes read-only queries such as rev-parse/remote).
 * @audience technical
 */
function tryGit(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * @purpose Builds the markdown body for the bootstrap-proposal pull request, summarizing scope and warning reviewers that the content is inferred.
 * @contract post: returns a markdown string naming how many entities/files were annotated (correctly pluralized) and listing every changed file, with a "please review before merging" disclaimer.
 *   side-effects: none.
 * @audience technical
 */
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
 *
 * @purpose Commits the annotation files (already written to disk by the caller) onto a fresh, uniquely-named branch instead of the branch the user had checked out, then best-effort pushes it and opens a PR via `gh` when a remote and authenticated gh CLI are available.
 * @contract pre: filesChanged have already been written to disk with their proposed annotations; repoRoot is expected to be a git repository.
 *   post: if the current branch can't be determined or filesChanged is empty, returns { branchName: "", pushed: false, prUrl: null } without touching the repo. Otherwise picks an unused branch name (livingdocs-bootstrap, or -2, -3, ... if taken), creates and checks it out, stages and commits exactly filesChanged with a message noting the file/entity counts and "INFERRED, needs review", then checks the original branch back out. If an `origin` remote exists, attempts to push the new branch (pushed: true on success) and, only then, attempts `gh pr create`, extracting the PR URL from the last line of its output into prUrl.
 *   throws: propagates whatever execFileSync throws (e.g. git binary missing, or `checkout -b`/`add`/`commit`/the final `checkout` back to the original branch failing, such as on a dirty or conflicting working tree) -- these four calls are, unlike the push/PR calls below, not wrapped in try/catch.
 *   side-effects: creates a new local git branch and commit containing filesChanged, leaves the working tree back on the original branch afterward; if `origin` exists, pushes the new branch to that remote (a real network write) and, if the push succeeds, may create a real pull request against it via `gh pr create` -- failures of the push or `gh` step are swallowed and reflected only in the returned pushed/prUrl fields, not thrown.
 * @audience technical
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

/**
 * @purpose Input configuration for runBootstrap: which LLM adapter drives synthesis, and the optional previously-collected business-context seed.
 * @audience technical
 */
export interface BootstrapOptions {
  llm: LlmAdapter;
  seed: BootstrapSeed | null;
}

/**
 * @purpose Summary of one runBootstrap run: documentation coverage before/after, which entities got proposals, which files were touched, and the resulting branch/push/PR state.
 * @audience technical
 */
export interface BootstrapResult {
  coverageBefore: number;
  coverageAfter: number;
  proposedEntities: string[];
  filesChanged: string[];
  branchName: string;
  pushed: boolean;
  prUrl: string | null;
}

/**
 * @purpose Computes the repo's current documentation-coverage percentage, used to report before/after progress around a bootstrap run.
 * @contract pre: repoRoot is a directory walkSourceFiles/extractor.ts can parse.
 *   post: returns 100 when there are zero documentable entities (nothing to document counts as fully covered); otherwise returns round(100 * documented / total), where total is countDocumentableEntities(repoRoot) and documented is the count of entities extractRepo(repoRoot) finds already carrying a doc comment (excluding module-level "module" entries, which countDocumentableEntities doesn't count as declarations).
 *   side-effects: none (reads and parses source files only).
 * @audience technical
 */
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
 *
 * @purpose Top-level bootstrap entry point: turns an entirely undocumented (or partially undocumented) repo into a reviewable documentation proposal by mining signals, asking the LLM to synthesize annotations, writing them into source, and committing them to a new branch/PR.
 * @contract pre: options.llm is a working LlmAdapter; options.seed is the previously-collected BootstrapSeed or null if none was collected.
 *   post: returns a BootstrapResult with coverage before/after, the keys of every entity that received a proposal, the list of files actually rewritten, and the branch/push/PR outcome from commitProposalToBranch. If there are no undocumented entities, returns immediately with coverageAfter equal to coverageBefore and empty/false/null for every other field, without calling the LLM or touching git. Only entities the LLM's response actually covers get annotated; a file is only rewritten (and appears in filesChanged) if at least one of its entities received a proposal.
 *   throws: propagates rejections from options.llm.complete (adapter/network/API errors); throws SyntaxError or Error("Expected a JSON array...") via parseSynthesisResponse when the LLM's response isn't a parseable JSON array; propagates errors from commitProposalToBranch (e.g. git binary missing or the checkout/add/commit sequence failing).
 *   side-effects: calls out to the LLM adapter (options.llm.complete); rewrites every source file that gets at least one accepted annotation, inserting comment blocks via insertAnnotationComments; and, via commitProposalToBranch, creates a new local git branch and commit for the changed files, checks back out to the original branch, and may push to `origin` and open a PR through `gh`.
 * @audience technical
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
    const adapter = adapterFor(filePath)!;
    const insertions = fileEntities
      .map((entity) => {
        const proposed = proposalByKey.get(`${entity.filePath}#${entity.entityName}`);
        return proposed ? { insertionIndex: entity.insertionIndex, commentBlock: adapter.formatAnnotation(proposed, entity.indent) } : null;
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
