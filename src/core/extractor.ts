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
type KnownTag = (typeof KNOWN_TAGS)[number];

const CONTRACT_CLAUSES = ["pre", "post", "throws", "side-effects", "deps"] as const;

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

function languageFor(filePath: string) {
  const ext = extname(filePath);
  if (ext === ".tsx") return TypeScriptLanguages.tsx;
  if (ext === ".ts") return TypeScriptLanguages.typescript;
  return JavaScriptLanguage;
}

function cleanCommentText(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

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

interface ParsedContract {
  preconditions: string[];
  postconditions: string[];
  errorModes: ErrorMode[];
  sideEffects: string[];
  deps: string[];
}

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

interface ParsedAnnotations {
  purpose: string | null;
  requirements: string[];
  audience: string[];
  contract: ParsedContract | null;
}

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

function findEntityName(declNode: Parser.SyntaxNode): string | null {
  const nameNode = declNode.children.find((c) => c.type === "identifier" || c.type === "type_identifier");
  return nameNode ? nameNode.text : null;
}

function extractSignature(declNode: Parser.SyntaxNode, source: string): string {
  const bodyChild = declNode.children.find((c) => BODY_NODE_TYPES.has(c.type));
  const end = bodyChild ? bodyChild.startIndex : declNode.endIndex;
  return source.slice(declNode.startIndex, end).trim();
}

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

function buildHumanNarrative(purpose: string | null): HumanNarrative {
  return { purpose, rationale: null, example: null, gotchas: [] };
}

function buildTags(requirements: string[], audience: string[]): string[] {
  const tags: string[] = [];
  for (const r of requirements) tags.push(`requirement:${r}`);
  for (const a of audience) tags.push(`audience:${a}`);
  return tags;
}

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

function resolveDeclaration(candidate: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined {
  if (!candidate) return undefined;
  if (candidate.type === "export_statement") {
    return candidate.children.find((c) => c.type in DECLARATION_TYPES);
  }
  return candidate.type in DECLARATION_TYPES ? candidate : undefined;
}

function parseSourceFile(filePath: string): { tree: Parser.Tree; source: string } {
  const source = readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(languageFor(filePath) as Parameters<Parser["setLanguage"]>[0]);
  return { tree: parser.parse(source), source };
}

/** Counts every top-level exported function/class/interface/type declaration, with or without a doc comment -- the denominator for annotation coverage. */
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

export function extractRepo(repoRoot: string): DocNode[] {
  return walkSourceFiles(repoRoot).flatMap((file) => extractFile(file, repoRoot));
}

export interface UndocumentedEntity {
  filePath: string;
  entityName: string;
  entityType: EntityType;
  signature: string;
  /** Byte offset where a new annotation comment should be inserted (start of the `export`/declaration line). */
  insertionIndex: number;
}

/**
 * Every top-level declaration with NO preceding doc comment at all --
 * the bootstrap pipeline's input (Phase 9). Deliberately does not
 * consider whether a comment, if present, actually contains our known
 * tags: that's a different, not-yet-needed distinction ("has a comment
 * but it's not ours" vs "has no comment").
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

/** Applies multiple comment insertions to one file's source, safely (in descending offset order so earlier insertions don't shift later ones). */
export function insertAnnotationComments(source: string, insertions: Array<{ insertionIndex: number; commentBlock: string }>): string {
  const sorted = [...insertions].sort((a, b) => b.insertionIndex - a.insertionIndex);
  let result = source;
  for (const { insertionIndex, commentBlock } of sorted) {
    result = `${result.slice(0, insertionIndex)}${commentBlock}\n${result.slice(insertionIndex)}`;
  }
  return result;
}
