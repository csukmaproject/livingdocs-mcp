/**
 * @purpose TypeScript/JavaScript LanguageAdapter -- a behavior-identical port of livingdocs' original (and only, pre-multi-language) extraction logic: JSDoc-style /** *\/ comments preceding function/class/interface/type-alias declarations, unwrapping `export` statements.
 * @audience technical
 */
import { extname } from "node:path";
import type Parser from "tree-sitter";
import TypeScriptLanguages from "tree-sitter-typescript";
import JavaScriptLanguage from "tree-sitter-javascript";
import type { EntityType } from "../types.js";
import { makeBlockCommentFinder, renderAnnotationBody, withIndent } from "./types.js";
import type { InsertionPlan, LanguageAdapter, ProposedAnnotation } from "./types.js";

const DECLARATION_TYPES: Record<string, EntityType> = {
  function_declaration: "function",
  class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
};

const BODY_NODE_TYPES = new Set(["statement_block", "class_body", "interface_body", "object_type"]);

/**
 * @purpose Picks the tree-sitter grammar to parse a file with, based on its extension.
 * @contract post: returns the TSX grammar for .tsx, the TypeScript grammar for .ts, and the JavaScript grammar for anything else (.js/.jsx).
 *   side-effects: none.
 * @audience technical
 */
function languageFor(filePath: string): unknown {
  const ext = extname(filePath);
  if (ext === ".tsx") return TypeScriptLanguages.tsx;
  if (ext === ".ts") return TypeScriptLanguages.typescript;
  return JavaScriptLanguage;
}

/**
 * @purpose Normalizes a top-level syntax node to the underlying declaration node this adapter understands, unwrapping export statements so "export function foo" and "function foo" are handled identically.
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

function entityTypeFor(declNode: Parser.SyntaxNode): EntityType | null {
  return DECLARATION_TYPES[declNode.type] ?? null;
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

const { findDocComment, findModuleDoc } = makeBlockCommentFinder("comment", resolveDeclaration);

function planUndocumentedInsertion(_declNode: Parser.SyntaxNode, rawCandidate: Parser.SyntaxNode, _source: string): InsertionPlan {
  return { insertionIndex: rawCandidate.startIndex, indent: "" };
}

function formatAnnotation(proposed: ProposedAnnotation, indent: string): string {
  const body = renderAnnotationBody(proposed);
  return withIndent(["/**", ...body.map((l) => ` * ${l}`), " */"], indent);
}

export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx"],
  testFilePattern: /\.(test|spec)\.[jt]sx?$/,
  languageFor,
  resolveDeclaration,
  entityTypeFor,
  findEntityName,
  extractSignature,
  findDocComment,
  findModuleDoc,
  planUndocumentedInsertion,
  formatAnnotation,
};
