/**
 * @purpose Defines the LanguageAdapter contract every per-language module (typescript.ts, go.ts, python.ts, java.ts) implements, plus the small set of shapes and helpers shared across adapters, so extractor.ts and bootstrap.ts can operate generically over whichever language a file belongs to.
 * @audience technical
 */
import type Parser from "tree-sitter";
import type { EntityType } from "../types.js";

/**
 * @purpose What an adapter hands back when it finds an entity's doc-comment/docstring: the cleaned, tag-ready text plus the byte offset to hash from.
 * @audience technical
 */
export interface DocTextMatch {
  /** Cleaned text, ready for parseAnnotations -- comment/docstring delimiters already stripped. */
  text: string;
  /** Byte offset marking the start of the range fed into computeContentHash (paired with the declaration's own endIndex). */
  hashRangeStart: number;
}

/**
 * @purpose A DocTextMatch for a module/file-level doc, which additionally carries its own end offset since it isn't paired with a declaration node.
 * @audience technical
 */
export interface ModuleDocTextMatch extends DocTextMatch {
  hashRangeEnd: number;
}

/**
 * @purpose Shape of one LLM-synthesized documentation proposal for a single entity, before it is rendered into a language-specific comment/docstring by an adapter's formatAnnotation.
 * @audience technical
 */
export interface ProposedAnnotation {
  key: string;
  purpose: string;
  contractPre: string[];
  contractPost: string[];
  contractSideEffects: string;
  audience: string[];
}

/**
 * @purpose Where and how to splice a newly-synthesized annotation into an undocumented declaration's source file.
 * @audience technical
 */
export interface InsertionPlan {
  /**
   * Byte offset to splice the rendered annotation text at. Must point at a position with no
   * unaccounted-for indentation between it and the insertion (column 0 of a fresh line, or --
   * equivalently, for a top-level declaration that always starts at column 0 -- its own startIndex),
   * since `indent` below is applied uniformly to every line including the first.
   */
  insertionIndex: number;
  /** Whitespace to prefix onto every line of the rendered text, including the first. "" for a before-declaration insertion at column 0 (TS/Go/Java); the body's own indentation for a body-start insertion (Python). */
  indent: string;
}

/**
 * @purpose The full set of language-specific operations extractor.ts and bootstrap.ts delegate to, so neither ever branches on "which language is this" directly.
 * @audience technical
 */
export interface LanguageAdapter {
  readonly id: string;
  readonly extensions: readonly string[];
  /** Matched against a file's basename (not full path) to recognize test files for bootstrap's test-reference signal source. */
  readonly testFilePattern: RegExp;
  /** Returns the tree-sitter Language object to parse a file of this adapter's language with. */
  languageFor(filePath: string): unknown;
  /** Given a top-level syntax node, returns the declaration node it represents (unwrapping export/decorator-style wrappers), or undefined if it isn't a recognized declaration. */
  resolveDeclaration(candidate: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined;
  /** Classifies an already-resolved declaration node into an EntityType, or null if it can't be classified. */
  entityTypeFor(declNode: Parser.SyntaxNode): EntityType | null;
  /** Finds the declared name of an already-resolved declaration node. */
  findEntityName(declNode: Parser.SyntaxNode): string | null;
  /** Extracts the signature text (everything before the body) for AgentContract.signature. */
  extractSignature(declNode: Parser.SyntaxNode, source: string): string;
  /** Finds the doc-comment/docstring attached to a declaration at topLevel[index], or null if undocumented. */
  findDocComment(declNode: Parser.SyntaxNode, topLevel: Parser.SyntaxNode[], index: number, source: string): DocTextMatch | null;
  /** Finds the file/module-level doc, or null. */
  findModuleDoc(topLevel: Parser.SyntaxNode[], source: string): ModuleDocTextMatch | null;
  /**
   * Computes where + with what indentation a newly-synthesized annotation should be inserted for an
   * undocumented declaration. rawCandidate is the original top-level node before resolveDeclaration's
   * unwrap (e.g. the export_statement/type_declaration wrapper) -- a "before declaration" insertion must
   * anchor on the WRAPPER's start, not the unwrapped inner node's, so the annotation lands before the
   * whole statement (e.g. before "export", not between "export" and "function"). Python's body-start
   * insertion ignores rawCandidate entirely, since a decorator wrapper doesn't affect where inside the
   * body a docstring belongs.
   */
  planUndocumentedInsertion(declNode: Parser.SyntaxNode, rawCandidate: Parser.SyntaxNode, source: string): InsertionPlan;
  /** Renders a ProposedAnnotation into this language's comment/docstring syntax, given the indent computed by planUndocumentedInsertion. */
  formatAnnotation(proposed: ProposedAnnotation, indent: string): string;
}

/**
 * @purpose Prefixes every line, including the first, with indent -- the counterpart to an InsertionPlan whose insertionIndex sits at column 0 (a fresh line for a body-start insertion, or a top-level declaration's own start, which is always column 0).
 * @contract pre: lines is non-empty.
 *   post: returns lines joined by newline, with indent prepended to every line.
 *   side-effects: none.
 * @audience technical
 */
export function withIndent(lines: string[], indent: string): string {
  return lines.map((line) => indent + line).join("\n");
}

/**
 * @purpose Renders a ProposedAnnotation's fields into the shared "@purpose/@contract/@audience" body lines used by every comment-writer, independent of the delimiter syntax (block comment, line comment, or docstring) wrapped around them.
 * @contract post: returns ["INFERRED ... please review ...", "@purpose <purpose>", "@contract <clauses>", "@audience <audience>"], where clauses includes "pre:"/"post:" only when the corresponding array is non-empty and always includes "side-effects:" (defaulting to "none").
 *   side-effects: none.
 * @audience technical
 */
export function renderAnnotationBody(proposed: ProposedAnnotation): string[] {
  const clauses: string[] = [];
  if (proposed.contractPre.length > 0) clauses.push(`pre: ${proposed.contractPre.join(". ")}.`);
  if (proposed.contractPost.length > 0) clauses.push(`post: ${proposed.contractPost.join(". ")}.`);
  clauses.push(`side-effects: ${proposed.contractSideEffects || "none"}.`);
  return [
    "INFERRED by livingdocs bootstrap -- please review before relying on this.",
    `@purpose ${proposed.purpose}`,
    `@contract ${clauses.join(" ")}`,
    `@audience ${proposed.audience.join(", ")}`,
  ];
}

/**
 * @purpose Builds a shared "leading /** *\/-style block comment" doc-finder pair, parameterized by the comment node's type name -- TypeScript/JS/Go all call this node "comment", but Java's grammar splits block vs line comments into distinct types, so the type name can't be hardcoded.
 * @contract pre: commentNodeType is the tree-sitter node type string this language's grammar uses for `/** ... *\/`-style block comments.
 *   post: returns findDocComment/findModuleDoc functions that recognize a preceding (or leading, for module) sibling of the given node type whose text starts with "/**" as the doc source.
 *   side-effects: none.
 * @audience technical
 */
export function makeBlockCommentFinder(
  commentNodeType: string,
  resolveDeclaration: (node: Parser.SyntaxNode | undefined) => Parser.SyntaxNode | undefined,
): {
  findDocComment: LanguageAdapter["findDocComment"];
  findModuleDoc: LanguageAdapter["findModuleDoc"];
} {
  function isDocBlock(node: Parser.SyntaxNode | undefined): node is Parser.SyntaxNode {
    return !!node && node.type === commentNodeType && node.text.startsWith("/**");
  }

  function findDocComment(
    _declNode: Parser.SyntaxNode,
    topLevel: Parser.SyntaxNode[],
    index: number,
    _source: string,
  ): DocTextMatch | null {
    const preceding = topLevel[index - 1];
    if (!isDocBlock(preceding)) return null;
    return { text: cleanBlockComment(preceding.text), hashRangeStart: preceding.startIndex };
  }

  function findModuleDoc(topLevel: Parser.SyntaxNode[], _source: string): ModuleDocTextMatch | null {
    const first = topLevel[0];
    if (!isDocBlock(first)) return null;
    // A leading doc comment already claimed by the declaration right after it (via findDocComment)
    // must not ALSO become a module doc -- the original comment-first loop enforced this with a
    // single if/else-if; this declaration-first design needs the same exclusion made explicit here.
    if (resolveDeclaration(topLevel[1])) return null;
    return { text: cleanBlockComment(first.text), hashRangeStart: first.startIndex, hashRangeEnd: first.endIndex };
  }

  return { findDocComment, findModuleDoc };
}

/**
 * @purpose Strips block-comment decoration (leading slash-star-star, trailing star-slash, per-line leading asterisks) from a raw `/** ... *\/`-style comment's text so only the annotation content remains -- shared by every adapter using makeBlockCommentFinder.
 * @contract pre: raw is the full text of a `/** ... *\/` comment node, including its delimiters.
 *   post: returns the de-commented, trimmed body text.
 *   side-effects: none.
 * @audience technical
 */
export function cleanBlockComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}
