/**
 * @purpose Java LanguageAdapter. Recognizes class/interface/enum declarations (no wrapper unwrap needed -- Java's modifiers/annotations are a child field of the declaration itself, not a separate sibling wrapper) and Javadoc-style /** *\/ doc comments. Note tree-sitter-java splits block vs line comments into distinct node types (block_comment/line_comment), unlike TS/JS/Go's unified "comment" type -- the shared block-comment finder is instantiated with "block_comment" here, not "comment".
 * @audience technical
 */
import type Parser from "tree-sitter";
import Java from "tree-sitter-java";
import type { EntityType } from "../types.js";
import { makeBlockCommentFinder, renderAnnotationBody, withIndent } from "./types.js";
import type { InsertionPlan, LanguageAdapter, ProposedAnnotation } from "./types.js";

const JAVA_DECLARATION_TYPES: Record<string, EntityType> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
};

const BODY_NODE_TYPES = new Set(["class_body", "interface_body", "enum_body"]);

function resolveDeclaration(candidate: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined {
  if (!candidate) return undefined;
  return candidate.type in JAVA_DECLARATION_TYPES ? candidate : undefined;
}

function entityTypeFor(declNode: Parser.SyntaxNode): EntityType | null {
  return JAVA_DECLARATION_TYPES[declNode.type] ?? null;
}

function findEntityName(declNode: Parser.SyntaxNode): string | null {
  return declNode.childForFieldName("name")?.text ?? null;
}

function extractSignature(declNode: Parser.SyntaxNode, source: string): string {
  const body = declNode.childForFieldName("body") ?? declNode.children.find((c) => BODY_NODE_TYPES.has(c.type));
  const end = body ? body.startIndex : declNode.endIndex;
  return source.slice(declNode.startIndex, end).trim();
}

// tree-sitter-java's block-comment node type is "block_comment", not the unified "comment" TS/JS/Go use --
// realistic Java files also have package/import statements before the first Javadoc, so findModuleDoc's
// index-0 check will rarely fire in practice (real Java file-level docs live in a separate
// package-info.java, out of scope here); that's an accurate reflection of Java convention, not a bug.
const { findDocComment, findModuleDoc } = makeBlockCommentFinder("block_comment", resolveDeclaration);

function planUndocumentedInsertion(_declNode: Parser.SyntaxNode, rawCandidate: Parser.SyntaxNode, _source: string): InsertionPlan {
  return { insertionIndex: rawCandidate.startIndex, indent: "" };
}

function formatAnnotation(proposed: ProposedAnnotation, indent: string): string {
  const body = renderAnnotationBody(proposed);
  return withIndent(["/**", ...body.map((l) => ` * ${l}`), " */"], indent);
}

export const javaAdapter: LanguageAdapter = {
  id: "java",
  extensions: [".java"],
  testFilePattern: /Test\.java$/,
  languageFor: () => Java,
  resolveDeclaration,
  entityTypeFor,
  findEntityName,
  extractSignature,
  findDocComment,
  findModuleDoc,
  planUndocumentedInsertion,
  formatAnnotation,
};
