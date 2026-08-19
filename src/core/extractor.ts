/**
 * @purpose Parses source files with tree-sitter to find top-level declarations and their attached doc-comments/docstrings, turning the frozen @purpose/@contract/@audience tag schema into structured DocNode records for the rest of the pipeline. Delegates every language-specific decision (which grammar, which node types, which comment/docstring convention) to a LanguageAdapter from ./languages/registry.js -- this file only implements the shared, language-agnostic tag-parsing pipeline and orchestration.
 * @audience technical
 */
import { extname, join, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import Parser from "tree-sitter";
import { adapterFor, isSupportedExtension } from "./languages/registry.js";
import type { LanguageAdapter } from "./languages/types.js";
import { computeContentHash } from "./hash-store.js";
import type { AgentContract, Confidence, DocNode, EntityType, ErrorMode, HumanNarrative } from "./types.js";

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".livingdocs"]);

const KNOWN_TAGS = ["purpose", "requirement", "contract", "audience"] as const;
/**
 * @purpose Narrows the recognized annotation tag names to a union type so tag lookups elsewhere are type-checked against KNOWN_TAGS instead of arbitrary strings.
 * @audience technical
 */
type KnownTag = (typeof KNOWN_TAGS)[number];

const CONTRACT_CLAUSES = ["pre", "post", "throws", "side-effects", "deps"] as const;

/**
 * @purpose Recursively collects every source file under a directory that some registered LanguageAdapter knows how to parse, skipping build/vendor/vcs folders.
 * @contract pre: rootDir exists and is readable.
 *   post: returns the absolute paths of all files under rootDir (recursively) whose extension is recognized by some registered LanguageAdapter, excluding IGNORED_DIRS subtrees.
 *   throws: Error when rootDir does not exist or a subdirectory is not readable (propagated from readdirSync/statSync).
 *   side-effects: none.
 * @audience technical
 */
export function walkSourceFiles(rootDir: string): string[] {
  const results: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
      } else if (isSupportedExtension(extname(entry))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * @purpose Splits a cleaned annotation comment/docstring body into its top-level @purpose/@requirement/@contract/@audience sections, keyed by tag name.
 * @contract pre: cleaned is already-cleaned text (comment/docstring delimiters already stripped by the owning LanguageAdapter).
 *   post: returns a map from each known tag found to its raw text; a tag repeated more than once has its occurrences joined with newlines; tags absent from the comment are omitted from the result.
 *   side-effects: none.
 * @audience technical
 */
function splitTopLevelTags(cleaned: string): Partial<Record<KnownTag, string>> {
  const tagAlternation = KNOWN_TAGS.join("|");
  const pattern = new RegExp(`@(${tagAlternation})\\b([\\s\\S]*?)(?=@(?:${tagAlternation})\\b|$)`, "g");
  const result: Partial<Record<KnownTag, string>> = {};
  for (const match of cleaned.matchAll(pattern)) {
    const tag = match[1] as KnownTag;
    const value = (match[2] ?? "").trim();
    result[tag] = result[tag] ? `${result[tag]}\n${value}` : value;
  }
  return result;
}

/**
 * @purpose Structured form of an @contract tag's clauses, split out by clause type (pre/post/throws/side-effects/deps) for consumption by buildAgentContract.
 * @audience technical
 */
interface ParsedContract {
  preconditions: string[];
  postconditions: string[];
  errorModes: ErrorMode[];
  sideEffects: string[];
  deps: string[];
}

/**
 * @purpose Parses the body of an @contract tag into discrete pre/post/throws/side-effects/deps clauses.
 * @contract pre: contractText is the raw text following an @contract tag (may contain multiple clauses in any order).
 *   post: returns a ParsedContract; "side-effects: none" is recognized as no side effects rather than the literal string "none"; each "throws: X when Y" clause is split into {errorType: X, condition: Y}, falling back to the whole clause as errorType when the "when" pattern is absent; "deps" is split on commas.
 *   side-effects: none.
 * @audience technical
 */
function parseContractClauses(contractText: string): ParsedContract {
  const clauseAlternation = CONTRACT_CLAUSES.join("|");
  const pattern = new RegExp(`(${clauseAlternation}):([\\s\\S]*?)(?=(?:${clauseAlternation}):|$)`, "gi");
  const result: ParsedContract = {
    preconditions: [],
    postconditions: [],
    errorModes: [],
    sideEffects: [],
    deps: [],
  };

  for (const match of contractText.matchAll(pattern)) {
    const clause = match[1]?.toLowerCase();
    const value = (match[2] ?? "").trim().replace(/\.$/, "");
    if (!value) continue;
    if (clause === "pre") {
      result.preconditions.push(value);
    } else if (clause === "post") {
      result.postconditions.push(value);
    } else if (clause === "side-effects") {
      if (value.toLowerCase() !== "none") result.sideEffects.push(value);
    } else if (clause === "throws") {
      const whenMatch = value.match(/^(\S+)\s+when\s+(.+)$/i);
      if (whenMatch && whenMatch[1] && whenMatch[2]) {
        result.errorModes.push({ errorType: whenMatch[1], condition: whenMatch[2].trim() });
      } else {
        result.errorModes.push({ errorType: value, condition: "" });
      }
    } else if (clause === "deps") {
      result.deps.push(
        ...value
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      );
    }
  }

  return result;
}

/**
 * @purpose Structured form of a whole annotation comment: its purpose text, requirement IDs, audience tags, and parsed contract, ready to be assembled into a DocNode.
 * @audience technical
 */
interface ParsedAnnotations {
  purpose: string | null;
  requirements: string[];
  audience: string[];
  contract: ParsedContract | null;
}

/**
 * @purpose Turns an already-cleaned doc-comment/docstring's text (delimiters already stripped by the owning LanguageAdapter) into the full set of annotation fields (purpose, requirement IDs, audience list, parsed contract) used to build a DocNode.
 * @contract pre: cleanedText is already-cleaned annotation text, as returned by a LanguageAdapter's findDocComment/findModuleDoc.
 *   post: returns purpose as the raw @purpose text or null if absent; requirements as a comma-split list (empty if no @requirement tag); audience as a comma/whitespace-split list (empty if no @audience tag); contract as the result of parseContractClauses, or null if no @contract tag was present.
 *   side-effects: none.
 * @audience technical
 */
function parseAnnotations(cleanedText: string): ParsedAnnotations {
  const tags = splitTopLevelTags(cleanedText);
  return {
    purpose: tags.purpose ?? null,
    requirements: tags.requirement
      ? tags.requirement
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
      : [],
    audience: tags.audience
      ? tags.audience
          .split(/[,\s]+/)
          .map((a) => a.trim())
          .filter(Boolean)
      : [],
    contract: tags.contract ? parseContractClauses(tags.contract) : null,
  };
}

/**
 * @purpose Assembles an AgentContract record from an extracted signature and an optionally-parsed @contract tag, defaulting every list field to empty when no contract was written.
 * @contract post: returns an AgentContract with the given signature and the parsed pre/post/side-effects/error-modes/deps, or empty arrays for any field parsed is null or omits.
 *   side-effects: none.
 * @audience technical
 */
function buildAgentContract(signature: string, parsed: ParsedContract | null): AgentContract {
  return {
    signature,
    preconditions: parsed?.preconditions ?? [],
    postconditions: parsed?.postconditions ?? [],
    sideEffects: parsed?.sideEffects ?? [],
    errorModes: parsed?.errorModes ?? [],
    dependencies: parsed?.deps ?? [],
  };
}

/**
 * @purpose Assembles a HumanNarrative record from the extracted @purpose text; rationale, example, and gotchas are not yet parsed from comments so they're always left empty/null.
 * @contract post: returns { purpose, rationale: null, example: null, gotchas: [] }.
 *   side-effects: none.
 * @audience technical
 */
function buildHumanNarrative(purpose: string | null): HumanNarrative {
  return { purpose, rationale: null, example: null, gotchas: [] };
}

/**
 * @purpose Flattens parsed requirement IDs and audience values into the DocNode.tags string list, prefixed by kind so both can be filtered on later.
 * @contract post: returns one "requirement:<id>" entry per requirement followed by one "audience:<value>" entry per audience value, in that order.
 *   side-effects: none.
 * @audience technical
 */
function buildTags(requirements: string[], audience: string[]): string[] {
  const tags: string[] = [];
  for (const r of requirements) tags.push(`requirement:${r}`);
  for (const a of audience) tags.push(`audience:${a}`);
  return tags;
}

/**
 * @purpose Derives which fields of a DocNode actually came from real extracted annotation content, so downstream consumers can tell "extracted" data from empty defaults.
 * @contract pre: node has agentContract and humanNarrative populated (e.g. by buildAgentContract/buildHumanNarrative).
 *   post: returns a map marking agentContract.signature/preconditions/postconditions/sideEffects/errorModes and humanNarrative.purpose as "extracted" whenever they are non-empty/non-null; fields that are empty or null are omitted from the map entirely.
 *   side-effects: none.
 * @audience technical
 */
function buildConfidence(node: Pick<DocNode, "agentContract" | "humanNarrative">): Record<string, Confidence> {
  const confidence: Record<string, Confidence> = {};
  if (node.agentContract.signature) confidence["agentContract.signature"] = "extracted";
  if (node.agentContract.preconditions.length) confidence["agentContract.preconditions"] = "extracted";
  if (node.agentContract.postconditions.length) confidence["agentContract.postconditions"] = "extracted";
  if (node.agentContract.sideEffects.length) confidence["agentContract.sideEffects"] = "extracted";
  if (node.agentContract.errorModes.length) confidence["agentContract.errorModes"] = "extracted";
  if (node.humanNarrative.purpose) confidence["humanNarrative.purpose"] = "extracted";
  return confidence;
}

/**
 * @purpose Assembles a DocNode for one annotated declaration.
 * @audience technical
 */
function buildNode(
  relativePath: string,
  entityName: string,
  entityType: EntityType,
  signature: string,
  annotations: ParsedAnnotations,
  contentHash: string,
): DocNode {
  const node: DocNode = {
    nodeId: `${relativePath}#${entityName}:${entityType}`,
    filePath: relativePath,
    entityName,
    entityType,
    contentHash,
    agentContract: buildAgentContract(signature, annotations.contract),
    humanNarrative: buildHumanNarrative(annotations.purpose),
    confidence: {},
    revisionHistory: [],
    tags: buildTags(annotations.requirements, annotations.audience),
  };
  node.confidence = buildConfidence(node);
  return node;
}

/**
 * @purpose Assembles the module-level DocNode for one file's leading doc-comment/docstring.
 * @audience technical
 */
function buildModuleNode(relativePath: string, annotations: ParsedAnnotations, contentHash: string): DocNode {
  const node: DocNode = {
    nodeId: `${relativePath}#module`,
    filePath: relativePath,
    entityName: relativePath,
    entityType: "module",
    contentHash,
    agentContract: buildAgentContract("", null),
    humanNarrative: buildHumanNarrative(annotations.purpose),
    confidence: {},
    revisionHistory: [],
    tags: buildTags(annotations.requirements, annotations.audience),
  };
  node.confidence = buildConfidence(node);
  return node;
}

/**
 * @purpose Reads a source file off disk and parses it into a tree-sitter syntax tree, resolving both the grammar and the LanguageAdapter to use from the file's extension.
 * @contract pre: filePath points to a readable file with an extension some registered LanguageAdapter recognizes.
 *   post: returns the parsed tree, the raw source text, and the resolved adapter.
 *   throws: Error when the file cannot be read (propagated from readFileSync), or when no adapter is registered for filePath's extension.
 *   side-effects: none.
 * @audience technical
 */
function parseSourceFile(filePath: string): { tree: Parser.Tree; source: string; adapter: LanguageAdapter } {
  const adapter = adapterFor(filePath);
  if (!adapter) throw new Error(`No language adapter registered for extension of ${filePath}`);
  const source = readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(adapter.languageFor(filePath) as Parameters<Parser["setLanguage"]>[0]);
  return { tree: parser.parse(source), source, adapter };
}

/**
 * @purpose Counts every top-level declaration this adapter recognizes in a repo (exported or not, documented or not) to serve as the denominator for annotation-coverage metrics.
 * @contract pre: repoRoot exists and is readable.
 *   post: returns the total count of recognized top-level declarations across every file walkSourceFiles finds under repoRoot.
 *   side-effects: none.
 * @audience technical
 */
export function countDocumentableEntities(repoRoot: string): number {
  let count = 0;
  for (const filePath of walkSourceFiles(repoRoot)) {
    const { tree, adapter } = parseSourceFile(filePath);
    for (const child of tree.rootNode.children) {
      if (adapter.resolveDeclaration(child)) count++;
    }
  }
  return count;
}

/**
 * @purpose Extracts every annotated entity in one source file into DocNode records: each top-level declaration with an attached doc-comment/docstring (per its LanguageAdapter's findDocComment) becomes an entity node, and the file's module-level doc (per findModuleDoc) becomes its module node.
 * @contract pre: filePath is a source file parseSourceFile can read and parse; repoRoot is an ancestor directory used to compute the node's stable relative-path-based ID.
 *   post: returns one DocNode per annotated declaration plus (at most) one module DocNode, each carrying its content hash, parsed agent contract, human narrative, tags, and derived confidence map; declarations or leading docs with no usable annotation are silently skipped.
 *   side-effects: none.
 * @audience technical
 */
export function extractFile(filePath: string, repoRoot: string): DocNode[] {
  const { tree, source, adapter } = parseSourceFile(filePath);
  const relativePath = relative(repoRoot, filePath);
  const topLevel = tree.rootNode.children;
  const nodes: DocNode[] = [];

  for (let i = 0; i < topLevel.length; i++) {
    const declNode = adapter.resolveDeclaration(topLevel[i]);
    if (!declNode) continue;
    const entityType = adapter.entityTypeFor(declNode);
    const entityName = adapter.findEntityName(declNode);
    if (!entityType || !entityName) continue;

    const doc = adapter.findDocComment(declNode, topLevel, i, source);
    if (!doc) continue;

    const annotations = parseAnnotations(doc.text);
    const signature = adapter.extractSignature(declNode, source);
    nodes.push(
      buildNode(relativePath, entityName, entityType, signature, annotations, computeContentHash(source.slice(doc.hashRangeStart, declNode.endIndex))),
    );
  }

  const moduleDoc = adapter.findModuleDoc(topLevel, source);
  if (moduleDoc) {
    const annotations = parseAnnotations(moduleDoc.text);
    if (annotations.purpose) {
      nodes.push(buildModuleNode(relativePath, annotations, computeContentHash(source.slice(moduleDoc.hashRangeStart, moduleDoc.hashRangeEnd))));
    }
  }

  return nodes;
}

/**
 * @purpose Extracts DocNodes for every documentable file in a repo by walking its source tree and running extractFile on each.
 * @contract pre: repoRoot exists and is readable.
 *   post: returns the concatenation of extractFile's results across every file walkSourceFiles finds under repoRoot.
 *   side-effects: none.
 * @audience technical
 */
export function extractRepo(repoRoot: string): DocNode[] {
  return walkSourceFiles(repoRoot).flatMap((file) => extractFile(file, repoRoot));
}

/**
 * @purpose Describes one top-level declaration that has no doc-comment/docstring at all, along with where and how (per its LanguageAdapter's planUndocumentedInsertion) a new annotation should be inserted.
 * @audience technical
 */
export interface UndocumentedEntity {
  filePath: string;
  entityName: string;
  entityType: EntityType;
  signature: string;
  /** Byte offset to splice the rendered annotation text at -- see LanguageAdapter.planUndocumentedInsertion. */
  insertionIndex: number;
  /** Indentation to apply to every line of the rendered annotation text -- see LanguageAdapter.planUndocumentedInsertion. */
  indent: string;
}

/**
 * @purpose Finds every top-level declaration that has no doc-comment/docstring at all, to drive the backfill pipeline that inserts starter annotations (Phase 9).
 * @contract pre: repoRoot exists and is readable.
 *   post: returns one UndocumentedEntity per declaration for which its LanguageAdapter's findDocComment returns null; a declaration with any doc-comment/docstring is treated as documented even if it doesn't use the known annotation tags -- distinguishing "has a doc but not ours" from "has none" is deliberately out of scope here.
 *   side-effects: none.
 * @audience technical
 */
export function listUndocumentedEntities(repoRoot: string): UndocumentedEntity[] {
  const results: UndocumentedEntity[] = [];
  for (const absPath of walkSourceFiles(repoRoot)) {
    const { tree, source, adapter } = parseSourceFile(absPath);
    const relativePath = relative(repoRoot, absPath);
    const topLevel = tree.rootNode.children;

    for (let i = 0; i < topLevel.length; i++) {
      const rawCandidate = topLevel[i];
      if (!rawCandidate) continue;
      const declNode = adapter.resolveDeclaration(rawCandidate);
      if (!declNode) continue;
      const entityType = adapter.entityTypeFor(declNode);
      const entityName = adapter.findEntityName(declNode);
      if (!entityType || !entityName) continue;

      const hasDoc = adapter.findDocComment(declNode, topLevel, i, source) !== null;
      if (hasDoc) continue;

      const plan = adapter.planUndocumentedInsertion(declNode, rawCandidate, source);
      results.push({
        filePath: relativePath,
        entityName,
        entityType,
        signature: adapter.extractSignature(declNode, source),
        insertionIndex: plan.insertionIndex,
        indent: plan.indent,
      });
    }
  }
  return results;
}

/**
 * @purpose Applies a batch of generated annotation comments to one file's source text in one pass.
 * @contract pre: each insertion's insertionIndex is a valid byte offset into source (typically the start of a declaration, as produced by listUndocumentedEntities).
 *   post: returns source with every commentBlock spliced in immediately before its insertionIndex, followed by a newline; insertions are applied in descending offset order internally so inserting one comment never shifts the offsets of insertions still pending.
 *   side-effects: none.
 * @audience technical
 */
export function insertAnnotationComments(source: string, insertions: Array<{ insertionIndex: number; commentBlock: string }>): string {
  const sorted = [...insertions].sort((a, b) => b.insertionIndex - a.insertionIndex);
  let result = source;
  for (const { insertionIndex, commentBlock } of sorted) {
    result = `${result.slice(0, insertionIndex)}${commentBlock}\n${result.slice(insertionIndex)}`;
  }
  return result;
}
