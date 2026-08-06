# Annotation Tag Vocabulary (draft — Phase 1 / APPROVAL GATE 1)

Four tags, written inside whatever native doc-comment syntax the host
language already uses (JSDoc `/** */`, Python docstrings, Rustdoc `///`,
etc.). The extractor locates the doc-comment attached to a named entity via
tree-sitter and parses `@tag` lines out of its text — the tags themselves
are language-agnostic.

```
@purpose      <one-line description of why this entity exists>
@requirement  <REQ-ID>[, <REQ-ID>...]
@contract     pre: <condition>. post: <condition>. throws: <ErrorType> when <condition>. side-effects: <description | none>.
@audience     <technical | business | agent-only> [, ...]
```

## Placement rule

One doc-comment block = one doc node. A block must sit immediately above a
named, exported (or otherwise externally-reachable) entity: function,
method, class, interface, type alias, exported const, module. Inner/nested
functions without their own tagged block do not get their own node.

## Tag-by-tag detail

### `@purpose`
Free text, one line. No change from the brief's draft.

### `@requirement`
Comma-separated list of IDs (not just one) — an entity can satisfy more
than one requirement. ID format isn't enforced by the extractor (teams may
use `REQ-042`, `PROJ-123`, etc.), just captured as-is.

**Change from brief's draft:** originally singular; now explicitly a list.

### `@contract`
Formalized into four named clauses so this is mechanically parsable
without an LLM. Clauses may be separated by periods on one line (matches
the brief's original example) or written one per line inside the comment
block — both parse to the same structure:

- `pre:` — precondition(s)
- `post:` — postcondition(s) / return-value description
- `throws:` — `<ErrorType> when <condition>` — **repeatable**, one per error
  type. Split out as its own clause (the brief's draft folded this into
  `post`) specifically so Phase 8's error↔troubleshooting cross-check can
  enumerate error types per entity without re-parsing prose.
- `side-effects:` — description, or literal `none`

Optional fifth clause:
- `deps:` — explicit dependency override, only needed when a real
  dependency is invisible to static analysis (reflection, string-based
  dynamic import). Normally dependencies are derived automatically from
  AST call/import edges, not hand-declared.

Unknown clause keywords are ignored with a lint warning (surfaces in
Phase 11's doc-linting pass), not a hard parse error.

### `@audience`
**Proposed change from brief's draft:** brief describes this as a single
enum value (`technical | business | agent-only`). Making it a
comma/space-separated list instead, because an entity can legitimately be
relevant to more than one audience (e.g. a public API that belongs in both
the technical guide and the business guide). Defaults to `technical` if
the tag is omitted entirely.

**Needs your confirmation**: keep as single-value enum (simpler, but
forces one bucket per entity) or make it multi-value as proposed above?

## Example (TypeScript)

```typescript
/**
 * @purpose Validates and normalizes a discount code before applying it.
 * @requirement REQ-042
 * @contract pre: code is non-empty string.
 *   post: returns normalized code.
 *   throws: InvalidDiscountError when code fails the format check.
 *   side-effects: none.
 * @audience technical, business
 */
function normalizeDiscountCode(code: string): string { ... }
```
