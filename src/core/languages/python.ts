/**
 * @purpose Python LanguageAdapter. Recognizes function/class definitions (unwrapping decorator wrappers), and docstrings -- a string-literal expression statement that is the first statement inside a definition's body (or the first statement of the whole module, for the module doc) -- rather than a preceding comment, since that's Python's actual documentation convention.
 * @audience technical
 */
import type Parser from "tree-sitter";
import Python from "tree-sitter-python";
import type { EntityType } from "../types.js";
import { renderAnnotationBody, withIndent } from "./types.js";
import type { DocTextMatch, InsertionPlan, LanguageAdapter, ModuleDocTextMatch, ProposedAnnotation } from "./types.js";

const PY_DECL_TYPES = new Set(["function_definition", "class_definition"]);

/**
 * @purpose Unwraps Python's decorator wrapper (decorated_definition) to the function/class it decorates -- essential in practice, since decorated declarations (@app.route, @dataclass, @staticmethod, ...) are extremely common.
 * @audience technical
 */
function resolveDeclaration(candidate: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined {
  if (!candidate) return undefined;
  if (candidate.type === "decorated_definition") {
    const inner = candidate.childForFieldName("definition");
    return inner && PY_DECL_TYPES.has(inner.type) ? inner : undefined;
  }
  return PY_DECL_TYPES.has(candidate.type) ? candidate : undefined;
}

function entityTypeFor(declNode: Parser.SyntaxNode): EntityType | null {
  if (declNode.type === "function_definition") return "function";
  if (declNode.type === "class_definition") return "class";
  return null;
}

function findEntityName(declNode: Parser.SyntaxNode): string | null {
  return declNode.childForFieldName("name")?.text ?? null;
}

/**
 * @purpose Extracts the signature (everything up to and including the trailing colon) by cutting at the body block's start.
 * @audience technical
 */
function extractSignature(declNode: Parser.SyntaxNode, source: string): string {
  const body = declNode.childForFieldName("body");
  const end = body ? body.startIndex : declNode.endIndex;
  return source.slice(declNode.startIndex, end).trim();
}

/**
 * @purpose Finds a docstring -- a bare string-literal expression statement -- as the first named child of a body/container, tree-sitter-python's actual structure for `def foo():\n    "text"`.
 * @contract post: returns the inner `string` node when children[0] is an expression_statement wrapping exactly a string, else null.
 *   side-effects: none.
 * @audience technical
 */
function leadingDocstring(children: Parser.SyntaxNode[]): Parser.SyntaxNode | null {
  const first = children[0];
  if (first?.type !== "expression_statement") return null;
  const inner = first.namedChildren[0];
  return inner?.type === "string" ? inner : null;
}

/**
 * @purpose Reads a string node's already-unquoted inner text via its string_content child (tree-sitter-python decomposes string, string_start/string_content/string_end), falling back to a manual quote/prefix strip for grammar variants without that decomposition.
 * @audience technical
 */
function stringContent(stringNode: Parser.SyntaxNode): string {
  const content = stringNode.namedChildren.find((c) => c.type === "string_content");
  if (content) return content.text;
  return stringNode.text.replace(/^[rRbBfFuU]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
}

function findDocComment(declNode: Parser.SyntaxNode, _topLevel: Parser.SyntaxNode[], _index: number, _source: string): DocTextMatch | null {
  const body = declNode.childForFieldName("body");
  if (!body) return null;
  const docstring = leadingDocstring(body.namedChildren);
  if (!docstring) return null;
  return { text: stringContent(docstring), hashRangeStart: declNode.startIndex };
}

function findModuleDoc(topLevel: Parser.SyntaxNode[], _source: string): ModuleDocTextMatch | null {
  // A module docstring (a top-level statement) and an entity docstring (nested inside a body) can never
  // structurally compete for the same node, unlike every other adapter's leading-comment model -- no
  // collision check against a following declaration is needed here.
  const docstring = leadingDocstring(topLevel);
  if (!docstring) return null;
  return { text: stringContent(docstring), hashRangeStart: docstring.startIndex, hashRangeEnd: docstring.endIndex };
}

/**
 * @purpose Plans inserting a new docstring as the definition body's new first statement, indented to match the body's existing first statement -- every valid function/class body has at least one statement (even a bare `pass`), so there's no truly-empty case to special-case.
 * @contract post: insertionIndex points at column 0 of the first statement's own line (NOT its first non-whitespace character) so the existing indentation whitespace on that line is left untouched, still prefixing the original first statement -- indent is applied to every line of the rendered docstring, including its own first line, since nothing before insertionIndex already provides it.
 *   side-effects: none.
 * @audience technical
 */
function planUndocumentedInsertion(declNode: Parser.SyntaxNode, _rawCandidate: Parser.SyntaxNode, _source: string): InsertionPlan {
  const body = declNode.childForFieldName("body")!;
  const firstStmt = body.namedChildren[0]!;
  const indent = " ".repeat(firstStmt.startPosition.column);
  return { insertionIndex: firstStmt.startIndex - firstStmt.startPosition.column, indent };
}

function formatAnnotation(proposed: ProposedAnnotation, indent: string): string {
  const [marker, ...rest] = renderAnnotationBody(proposed);
  return withIndent([`"""${marker}`, "", ...rest, '"""'], indent);
}

export const pythonAdapter: LanguageAdapter = {
  id: "python",
  extensions: [".py"],
  testFilePattern: /^test_.*\.py$|.*_test\.py$/,
  languageFor: () => Python,
  resolveDeclaration,
  entityTypeFor,
  findEntityName,
  extractSignature,
  findDocComment,
  findModuleDoc,
  planUndocumentedInsertion,
  formatAnnotation,
};
