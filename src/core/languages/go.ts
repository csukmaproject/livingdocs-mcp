/**
 * @purpose Go LanguageAdapter. Recognizes function/method declarations and struct/interface/type-alias declarations (via type_declaration -> type_spec), and idiomatic Go doc comments -- contiguous `//` line-comment runs with no blank line between the run and the declaration -- as well as plain `/** *\/` block comments.
 * @audience technical
 */
import type Parser from "tree-sitter";
import Go from "tree-sitter-go";
import type { EntityType } from "../types.js";
import { makeBlockCommentFinder, renderAnnotationBody, withIndent } from "./types.js";
import type { DocTextMatch, InsertionPlan, LanguageAdapter, ModuleDocTextMatch, ProposedAnnotation } from "./types.js";

const GO_DECL_TYPES = new Set(["function_declaration", "method_declaration"]);
const TYPE_LIKE_TYPES = new Set(["type_spec", "type_alias"]);
const BODY_NODE_TYPES = new Set(["block"]);

/**
 * @purpose Unwraps Go's type_declaration wrapper to the single type_spec/type_alias it contains, or leaves any other candidate untouched.
 * @contract post: for a type_declaration with exactly one type_spec/type_alias child, returns that child; for a type_declaration with zero or more than one (a grouped `type ( A; B )` block), returns undefined -- v1 deliberately skips grouped type blocks rather than guessing which spec is "the" declaration; for function_declaration/method_declaration, returns the node itself; otherwise undefined.
 *   side-effects: none.
 * @audience technical
 */
function resolveDeclaration(candidate: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined {
  if (!candidate) return undefined;
  if (candidate.type === "type_declaration") {
    const specs = candidate.namedChildren.filter((c): c is Parser.SyntaxNode => !!c && TYPE_LIKE_TYPES.has(c.type));
    return specs.length === 1 ? specs[0] : undefined;
  }
  return GO_DECL_TYPES.has(candidate.type) ? candidate : undefined;
}

/**
 * @purpose Classifies a type_spec/type_alias node by inspecting its own `type` field: a struct_type is a struct, an interface_type is an interface, anything else (a named alias over string/int/map/slice/etc.) is a plain type.
 * @audience technical
 */
function classifyTypeLike(node: Parser.SyntaxNode): EntityType {
  const typeField = node.childForFieldName("type");
  if (typeField?.type === "struct_type") return "struct";
  if (typeField?.type === "interface_type") return "interface";
  return "type";
}

function entityTypeFor(declNode: Parser.SyntaxNode): EntityType | null {
  if (declNode.type === "function_declaration") return "function";
  if (declNode.type === "method_declaration") return "method";
  if (TYPE_LIKE_TYPES.has(declNode.type)) return classifyTypeLike(declNode);
  return null;
}

function findEntityName(declNode: Parser.SyntaxNode): string | null {
  return declNode.childForFieldName("name")?.text ?? null;
}

/**
 * @purpose Extracts the declaration's signature text (everything before its body) -- the body field for functions/methods, the struct's field-declaration-list for structs, or the whole span as a fallback for interfaces and plain aliases (which have no single "body" child to cut at).
 * @audience technical
 */
function extractSignature(declNode: Parser.SyntaxNode, source: string): string {
  if (TYPE_LIKE_TYPES.has(declNode.type)) {
    const typeField = declNode.childForFieldName("type");
    if (typeField?.type === "struct_type") {
      const fieldList = typeField.children.find((c) => c.type === "field_declaration_list");
      const end = fieldList ? fieldList.startIndex : typeField.endIndex;
      return source.slice(declNode.startIndex, end).trim();
    }
    return source.slice(declNode.startIndex, declNode.endIndex).trim();
  }
  const bodyChild = declNode.children.find((c) => BODY_NODE_TYPES.has(c.type));
  const end = bodyChild ? bodyChild.startIndex : declNode.endIndex;
  return source.slice(declNode.startIndex, end).trim();
}

function isLineComment(node: Parser.SyntaxNode | undefined): node is Parser.SyntaxNode {
  return !!node && node.type === "comment" && !node.text.startsWith("/*");
}

/**
 * @purpose Walks backward from beforeIndex collecting the maximal run of `//` line comments that are mutually row-adjacent (no blank line between any two, or between the run and beforeIndex's own predecessor) -- idiomatic Go doc comments are exactly this shape.
 * @contract post: returns the run in source order (earliest first), or [] if topLevel[beforeIndex - 1] isn't itself a qualifying line comment.
 *   side-effects: none.
 * @audience technical
 */
function collectPrecedingLineCommentRun(topLevel: Parser.SyntaxNode[], beforeIndex: number): Parser.SyntaxNode[] {
  const first = topLevel[beforeIndex - 1];
  if (!isLineComment(first)) return [];
  const run = [first];
  let i = beforeIndex - 2;
  while (i >= 0) {
    const candidate = topLevel[i];
    if (!isLineComment(candidate) || candidate.endPosition.row + 1 !== run[0]!.startPosition.row) break;
    run.unshift(candidate);
    i--;
  }
  return run;
}

/**
 * @purpose Strips each line's leading "//" (and one optional following space) and joins the run into one logical doc-comment text.
 * @audience technical
 */
function mergeLineComments(run: Parser.SyntaxNode[]): string {
  return run.map((n) => n.text.replace(/^\/\/ ?/, "")).join("\n");
}

const blockFinder = makeBlockCommentFinder("comment", resolveDeclaration);

function findDocComment(declNode: Parser.SyntaxNode, topLevel: Parser.SyntaxNode[], index: number, source: string): DocTextMatch | null {
  const blockMatch = blockFinder.findDocComment(declNode, topLevel, index, source);
  if (blockMatch) return blockMatch;

  const run = collectPrecedingLineCommentRun(topLevel, index);
  if (run.length === 0) return null;
  const last = run[run.length - 1]!;
  if (declNode.startPosition.row !== last.endPosition.row + 1) return null; // blank line between the run and the declaration
  return { text: mergeLineComments(run), hashRangeStart: run[0]!.startIndex };
}

function findModuleDoc(topLevel: Parser.SyntaxNode[], source: string): ModuleDocTextMatch | null {
  const blockMatch = blockFinder.findModuleDoc(topLevel, source);
  if (blockMatch) return blockMatch;

  if (!isLineComment(topLevel[0])) return null;
  let end = 1;
  while (end < topLevel.length && isLineComment(topLevel[end]) && topLevel[end]!.startPosition.row === topLevel[end - 1]!.endPosition.row + 1) {
    end++;
  }
  const run = topLevel.slice(0, end);
  // A leading run already claimed by the declaration right after it (via findDocComment) is not a module doc.
  if (resolveDeclaration(topLevel[end])) return null;
  return { text: mergeLineComments(run), hashRangeStart: run[0]!.startIndex, hashRangeEnd: run[run.length - 1]!.endIndex };
}

function planUndocumentedInsertion(_declNode: Parser.SyntaxNode, rawCandidate: Parser.SyntaxNode, _source: string): InsertionPlan {
  return { insertionIndex: rawCandidate.startIndex, indent: "" };
}

function formatAnnotation(proposed: ProposedAnnotation, indent: string): string {
  const body = renderAnnotationBody(proposed);
  return withIndent(
    body.map((l) => `// ${l}`),
    indent,
  );
}

export const goAdapter: LanguageAdapter = {
  id: "go",
  extensions: [".go"],
  testFilePattern: /_test\.go$/,
  languageFor: () => Go,
  resolveDeclaration,
  entityTypeFor,
  findEntityName,
  extractSignature,
  findDocComment,
  findModuleDoc,
  planUndocumentedInsertion,
  formatAnnotation,
};
