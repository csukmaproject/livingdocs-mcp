# Changelog

All notable changes to this project are documented here. Semantic
versioning from `1.0.0` onward.

## [1.1.0]

### Added
- Claude Code plugin marketplace support: `.claude-plugin/marketplace.json`
  at the repo root, plus a `plugin/` directory
  (`.claude-plugin/plugin.json`, bundled `.mcp.json`, and the
  `livingdocs-sync` skill) so the repo installs directly with
  `/plugin marketplace add csukmaproject/livingdocs-mcp` and
  `/plugin install livingdocs@livingdocs-mcp` -- no manual `.mcp.json`
  edit or `CLAUDE.md` paste required.

## [1.0.0]

Feature-complete v1: every document type in `docgen-plugin-plan.md`
Section 7's table generates from the same doc graph, CI is wired up, and
the regression suite covers all three fixture repos.

### Added
- Per-tool adapter templates for Claude Code, Codex CLI, and Cursor
  (`/adapters`), plus a host table in the README.
- Confidence tagging (`extracted`/`inferred`) and the first LLM-heavy
  rollups: User Guide Sections 4 (Core Features) and 5 (Troubleshooting),
  batched per regeneration and scoped to only changed entities.
- The bootstrap pipeline for existing/undocumented repos
  (`livingdocs bootstrap`): code structure, tests, git co-change history,
  and naming clustering feed an LLM synthesis pass, always tagged
  `INFERRED` and proposed via a PR rather than committed directly.
- Five new document types reusing the same rollup engine: Agent Contract
  Reference, SRS, PRD, Technical Guide, and Business Guide
  (`livingdocs generate <type>`).
- CI integration: `.github/workflows/livingdocs.yml` runs `scan`/`update`
  on every PR and posts a comment by default (no direct commit), with an
  opt-in `ci.autoCommit` flag via `livingdocs.config.json`.
- The `greenfield` fixture (fully annotated from day one) alongside
  `documented` and `undocumented`, plus `.github/workflows/ci.yml`
  running the full test suite (build, typecheck, lint, `npm test`) on
  every push/PR.

### Fixed
- `npx <pkg> <bin>` breaks when a package's bin name matches its own
  unscoped package name and it's invoked from within a checkout of its
  own source (only affects this repo's own CI dogfooding, not consumers)
  -- worked around by building from source in `livingdocs.yml` instead.
- A cosmetic edit (e.g. rewording `@purpose`) used to silently wipe
  previously-generated `rationale`/`example`/`gotchas`, since the file
  gets mechanically re-extracted with those fields blank. Now carried
  forward explicitly.
- `scanRepo` used to scope re-extraction to `git status` alone, which
  misread a clean working tree as "nothing changed" even on the very
  first run or when committed history had moved since the graph was last
  saved. Now tracks `lastScannedCommit` and diffs since that commit too.

## [0.1.0]

Initial release: mechanical extraction, the MCP server, and the CLI.

### Added
- Annotation tag vocabulary (`@purpose`/`@requirement`/`@contract`/
  `@audience`, `docs/annotation-tags.md`) and the frozen doc-node JSON
  schema (`livingdocs.config.schema.json`).
- The core library: tree-sitter-based extraction (zero LLM calls),
  hash-based staleness detection, cosmetic-vs-contract-affecting ast-diff
  classification, and the append-only revision-history writer.
- The User Guide rollup, Sections 2 (System Overview) and 3
  (Getting Started) -- pure templating, zero LLM calls.
- The MCP stdio server (`analyze_change`, `get_contract`, `update_doc`,
  `generate_rollup`, `get_doc_history`), with model access via MCP
  sampling.
- The CLI (`scan`/`update`/`generate`/`status`), falling back to a direct
  Anthropic API key when no MCP host is present.
- Published to npm as `@csukmaproject/livingdocs-mcp`.
