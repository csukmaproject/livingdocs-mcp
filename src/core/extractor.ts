/**
 * @purpose Parses TypeScript/JavaScript source files with tree-sitter to find top-level declarations and their attached JSDoc-style annotation comments, turning the frozen @purpose/@contract/@audience tag schema into structured DocNode records for the rest of the pipeline.
 * @audience technical
 */
import { extname, join, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import Parser from "tree-sitter";
import TypeScriptLanguages from "tree-sitter-typescript";
import JavaScriptLanguage from "tree-sitter-javascript";
import { computeContentHash } from "./hash-store.js";
import type { AgentContract, Confidence, DocNode, EntityType, ErrorMode, HumanNarrative } from "./types.js";

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".livingdocs"]);
const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const DECLARATION_TYPES: Record<string, EntityType> = {
  function_declaration: "function",
  class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
};

const BODY_NODE_TYPES = new Set(["statement_block", "class_body", "interface_body", "object_type"]);

const KNOWN_TAGS = ["purpose", "requirement", "contract", "audience"] as const;
/**
 * @purpose Narrows the recognized annotation tag names to a union type so tag lookups elsewhere are type-checked against KNOWN_TAGS instead of arbitrary strings.
 * @audience technical
 */
type KnownTag = (typeof KNOWN_TAGS)[number];

const CONTRACT_CLAUSES = ["pre", "post", "throws", "side-effects", "deps"] as const;

/**
 * @purpose Recursively collects every source file under a directory that the extractor knows how to parse, skipping build/vendor/vcs folders.
 * @contract pre: rootDir exists and is readable.
 *   post: returns the absolute paths of all files under rootDir (recursively) whose extension is in SUPPORTED_EXTENSIONS, excluding IGNORED_DIRS subtrees.
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
      } else if (SUPPORTED_EXTENSIONS.has(extname(entry))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * @purpose Picks the tree-sitter grammar to parse a file with, based on its extension.
 * @contract post: returns the TSX grammar for .tsx, the TypeScript grammar for .ts, and the JavaScript grammar for anything else (.js/.jsx).
 *   side-effects: none.
 * @audience technical
 */
function languageFor(filePath: string) {
  const ext = extname(filePath);
  if (ext === ".tsx") return TypeScriptLanguages.tsx;
  if (ext === ".ts") return TypeScriptLanguages.typescript;
  return JavaScriptLanguage;
}

/**
 * @purpose Strips block-comment decoration (leading slash-star-star, trailing star-slash, per-line leading asterisks) from a raw comment's text so only the annotation content remains.
 * @contract pre: raw is the full text of a comment node, including its delimiters.
 *   post: returns the de-commented, trimmed body text.
 *   side-effects: none.
 * @audience technical
 */
function cleanCommentText(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

/**
 * @purpose Splits a cleaned annotation comment body into its top-level @purpose/@requirement/@contract/@audience sections, keyed by tag name.
 * @contract pre: cleaned is the de-commented text produced by cleanCommentText.
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
 * @purpose Turns a raw JSDoc-style comment's text into the full set of annotation fields (purpose, requirement IDs, audience list, parsed contract) used to build a DocNode.
 * @contract pre: commentText is the full text of a comment node.
 *   post: returns purpose as the raw @purpose text or null if absent; requirements as a comma-split list (empty if no @requirement tag); audience as a comma/whitespace-split list (empty if no @audience tag); contract as the result of parseContractClauses, or null if no @contract tag was present.
 *   side-effects: none.
 * @audience technical
 */
function parseAnnotations(commentText: string): ParsedAnnotations {
  const cleaned = cleanCommentText(commentText);
  const tags = splitTopLevelTags(cleaned);
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
 * @purpose Reads the declared name (function/class/interface/type name) off a declaration node.
 * @contract pre: declNode is a function_declaration, class_declaration, interface_declaration, or type_alias_declaration node.
 *   post: returns the text of the first identifier/type_identifier child, or null if none is found.
 *   side-effects: none.
 * @audience technical
 */
function findEntityName(declNode: Parser.SyntaxNode): string | null {
  const nameNode = declNode.children.find((c) => c.type === "identifier" || c.type === "type_identifier");
  return nameNode ? nameNode.text : null;
}

/**
 * @purpose Extracts the declaration's signature text (everything before its body) for storage in AgentContract.signature.
 * @contract pre: declNode is a recognized declaration node; source is the full file text it was parsed from.
 *   post: returns the trimmed source slice from the declaration's start up to (but not including) its body block, or the whole declaration text if it has no body (e.g. a type alias).
 *   side-effects: none.
 * @audience technical
 */
function extractSignature(declNode: Parser.SyntaxNode, source: string): string {
  const bodyChild = declNode.children.find((c) => BODY_NODE_TYPES.has(c.type));
  const end = bodyChild ? bodyChild.startIndex : declNode.endIndex;
  return source.slice(declNode.startIndex, end).trim();
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
 * @purpose Normalizes a top-level syntax node to the underlying declaration node the extractor understands, unwrapping export statements so "export function foo" and "function foo" are handled identically.
 * @contract post: returns the node itself if its type is a function/class/interface/type-alias declaration; if it's an export_statement, returns its wrapped declaration child (or undefined if that child isn't a recognized declaration type); returns undefined for anything else, including an undefined input.
 *   side-effects: none.
 * @audience technical
 */
function resolveDeclaration(candidate: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined {
  if (!candidate) return undefined;
  if (candidate.type === "export_statement") {
    return candidate.children.find((c) => c.type in DECLARATION_TYPES);
  }
  return candidate.type in DECLARATION_TYPES ? candidate : undefined;
}

/**
 * @purpose Reads a source file off disk and parses it into a tree-sitter syntax tree, selecting the grammar by file extension.
 * @contract pre: filePath points to a readable file with a supported extension.
 *   post: returns the parsed tree alongside the raw source text (the caller needs both for byte-offset slicing).
 *   throws: Error when the file cannot be read (propagated from readFileSync).
 *   side-effects: none.
 * @audience technical
 */
function parseSourceFile(filePath: string): { tree: Parser.Tree; source: string } {
  const source = readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(languageFor(filePath) as Parameters<Parser["setLanguage"]>[0]);
  return { tree: parser.parse(source), source };
}

/**
 * @purpose Counts every top-level function/class/interface/type declaration in a repo (exported or not, documented or not) to serve as the denominator for annotation-coverage metrics.
 * @contract pre: repoRoot exists and is readable.
 *   post: returns the total count of recognized top-level declarations across every file walkSourceFiles finds under repoRoot.
 *   side-effects: none.
 * @audience technical
 */
export function countDocumentableEntities(repoRoot: string): number {
  let count = 0;
  for (const filePath of walkSourceFiles(repoRoot)) {
    const { tree } = parseSourceFile(filePath);
    for (const child of tree.rootNode.children) {
      if (resolveDeclaration(child)) count++;
    }
  }
  return count;
}

/**
 * @purpose Extracts every annotated entity in one source file into DocNode records: each JSDoc-style comment immediately followed by a recognized declaration becomes an entity node, and a leading comment with no declaration after it (and a real @purpose) becomes the file's module node.
 * @contract pre: filePath is a source file parseSourceFile can read and parse; repoRoot is an ancestor directory used to compute the node's stable relative-path-based ID.
 *   post: returns one DocNode per annotated declaration plus (at most) one module DocNode, each carrying its content hash, parsed agent contract, human narrative, tags, and derived confidence map; declarations or leading comments with no usable annotation are silently skipped.
 *   side-effects: none.
 * @audience technical
 */
export function extractFile(filePath: string, repoRoot: string): DocNode[] {
  const { tree, source } = parseSourceFile(filePath);
  const relativePath = relative(repoRoot, filePath);
  const nodes: DocNode[] = [];
  const topLevel = tree.rootNode.children;

  for (let i = 0; i < topLevel.length; i++) {
    const child = topLevel[i];
    if (!child || child.type !== "comment" || !child.text.startsWith("/**")) continue;

    const declNode = resolveDeclaration(topLevel[i + 1]);

    if (declNode) {
      const entityType = DECLARATION_TYPES[declNode.type];
      const entityName = findEntityName(declNode);
      if (!entityType || !entityName) continue;

      const annotations = parseAnnotations(child.text);
      const signature = extractSignature(declNode, source);
      const nodeId = `${relativePath}#${entityName}:${entityType}`;

      const node: DocNode = {
        nodeId,
        filePath: relativePath,
        entityName,
        entityType,
        contentHash: computeContentHash(source.slice(child.startIndex, declNode.endIndex)),
        agentContract: buildAgentContract(signature, annotations.contract),
        humanNarrative: buildHumanNarrative(annotations.purpose),
        confidence: {},
        revisionHistory: [],
        tags: buildTags(annotations.requirements, annotations.audience),
      };
      node.confidence = buildConfidence(node);
      nodes.push(node);
    } else if (i === 0) {
      // A leading doc comment not attached to a declaration documents the module itself.
      const annotations = parseAnnotations(child.text);
      if (annotations.purpose) {
        const node: DocNode = {
          nodeId: `${relativePath}#module`,
          filePath: relativePath,
          entityName: relativePath,
          entityType: "module",
          contentHash: computeContentHash(source.slice(child.startIndex, child.endIndex)),
          agentContract: buildAgentContract("", null),
          humanNarrative: buildHumanNarrative(annotations.purpose),
          confidence: {},
          revisionHistory: [],
          tags: buildTags(annotations.requirements, annotations.audience),
        };
        node.confidence = buildConfidence(node);
        nodes.push(node);
      }
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
 * @purpose Describes one top-level declaration that has no preceding doc comment at all, along with where a new annotation should be inserted.
 * @audience technical
 */
export interface UndocumentedEntity {
  filePath: string;
  entityName: string;
  entityType: EntityType;
  signature: string;
  /** Byte offset where a new annotation comment should be inserted (start of the `export`/declaration line). */
  insertionIndex: number;
}

/**
 * @purpose Finds every top-level declaration that has no doc comment at all, to drive the backfill pipeline that inserts starter annotations (Phase 9).
 * @contract pre: repoRoot exists and is readable.
 *   post: returns one UndocumentedEntity per declaration whose immediately preceding top-level sibling is not a JSDoc-style comment; a declaration preceded by any JSDoc-style comment is treated as documented even if that comment doesn't use the known annotation tags -- distinguishing "has a comment but not ours" from "has no comment" is deliberately out of scope here.
 *   side-effects: none.
 * @audience technical
 */
export function listUndocumentedEntities(repoRoot: string): UndocumentedEntity[] {
  const results: UndocumentedEntity[] = [];
  for (const absPath of walkSourceFiles(repoRoot)) {
    const { tree, source } = parseSourceFile(absPath);
    const relativePath = relative(repoRoot, absPath);
    const topLevel = tree.rootNode.children;

    for (let i = 0; i < topLevel.length; i++) {
      const child = topLevel[i];
      if (!child) continue;
      const declNode = resolveDeclaration(child);
      if (!declNode) continue;
      const entityType = DECLARATION_TYPES[declNode.type];
      const entityName = findEntityName(declNode);
      if (!entityType || !entityName) continue;

      const preceding = topLevel[i - 1];
      const hasDocComment = Boolean(preceding && preceding.type === "comment" && preceding.text.startsWith("/**"));
      if (hasDocComment) continue;

      results.push({
        filePath: relativePath,
        entityName,
        entityType,
        signature: extractSignature(declNode, source),
        insertionIndex: child.startIndex,
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
