# Auto-Doc MCP Server — Build Brief for Claude Code

## Context

Build an open-source MCP server (with companion CLI) that keeps software
documentation in permanent sync with code, for both AI agents and humans.
Full architecture rationale lives in `docgen-plugin-plan.md` — read that
first if it's present in the repo. This brief is the execution sequence.

**Confirmed project identity:**
- GitHub repo: `github.com/csukmaproject/livingdocs-mcp`
- npm package: `@csukmaproject/livingdocs-mcp`
- Both confirmed available/reachable prior to starting this build.

**Non-negotiable design decisions (do not re-derive or change these):**
- Distribution: npm package + GitHub repo. No hosted server, no database.
- Transport: MCP stdio only for v1. No HTTP/SSE.
- Model access: MCP sampling first (borrow the host agent's model);
  direct API key only as a CLI/CI fallback.
- Storage: markdown files + hidden hash-comments, committed to the
  target repo. Never a separate versioned copy of a doc file.
- Docs are rollups over a doc graph, never independently authored per type.

Work through the phases in order. **Stop and ask for my confirmation at
each "APPROVAL GATE" before continuing** — don't proceed past one on your
own judgment alone.

---

## Phase 0 — Repo & Tooling Setup

- Initialize a new TypeScript/Node project.
- Package manager: npm. Node version: latest LTS.
- Directory structure:
  ```
  /src
    /core          # framework-agnostic logic
    /mcp           # MCP server (stdio)
    /cli           # CLI wrapper
    /templates     # doc skeletons (user-guide-template.md etc.)
  /test
    /fixtures      # sample repos: documented / undocumented / greenfield
  /.github/workflows
  package.json
  tsconfig.json
  README.md
  LICENSE
  livingdocs.config.schema.json
  ```
- `package.json`: name it `@csukmaproject/livingdocs-mcp`.
- Add `bin` entries for both the CLI and the MCP server binary.
- Set up ESLint + Prettier + `tsup` (or equivalent) for build.
- Add `vitest` (or `jest`) for testing.
- Initialize git, first commit: "chore: project scaffold".
- Set the git remote to `github.com/csukmaproject/livingdocs-mcp` (repo must
  exist on GitHub first — create it manually if not already there).

**Definition of done:** `npm run build` and `npm test` both run
successfully on an empty scaffold, and the repo pushes cleanly to
`github.com/csukmaproject/livingdocs-mcp`.

---

## Phase 1 — Freeze the Schemas

This is the highest-leverage phase — everything downstream depends on this
being stable. Do not start Phase 2 until this is confirmed.

### 1.1 Annotation tag vocabulary (in-code, language-agnostic comment syntax)

Draft starting point — refine but keep the four tags:

```
@purpose      <one-line description of why this entity exists>
@requirement  <REQ-ID, links this entity to a PRD requirement>
@contract     <preconditions, postconditions, side effects, error modes>
@audience     <technical | business | agent-only>
```

Example (TypeScript):
```typescript
/**
 * @purpose Validates and normalizes a discount code before applying it.
 * @requirement REQ-042
 * @contract pre: code is non-empty string. post: returns normalized code
 *   or throws InvalidDiscountError. side-effects: none.
 * @audience technical
 */
function normalizeDiscountCode(code: string): string { ... }
```

### 1.2 Doc-node JSON schema

Define `livingdocs.config.schema.json` covering:
- `nodeId`, `filePath`, `entityName`, `entityType`
- `contentHash` (of the source code this node was derived from)
- `agentContract` facet (structured: signature, pre/post, side effects, deps)
- `humanNarrative` facet (prose: purpose, rationale, example, gotchas)
- `confidence`: `extracted | verified | inferred`
- `revisionHistory`: array of `{ commit, date, summary }`
- `tags`: array (`requirement:REQ-042`, `audience:business`, etc.)

**APPROVAL GATE 1** — Show me both schemas before writing extraction code.
I will confirm or request changes.

---

## Phase 2 — Core Library

Build framework-agnostic, no agent-specific code anywhere in `/src/core`.

- `ast-diff.ts` — tree-sitter based diff; classify each changed entity as
  `cosmetic` or `contract-affecting`.
- `doc-graph.ts` — graph structure of doc nodes + edges (calls/imports).
- `hash-store.ts` — per-node content hash, persisted alongside the doc
  graph (JSON file in the target repo, e.g. `.livingdocs/graph.json`).
- `extractor.ts` — parses annotations + code structure into doc nodes
  (no LLM — this must work on mechanical extraction alone first).
- `rollup-engine.ts` — filters/composes doc nodes into document types
  (start with the User Guide sections 2–3 only, which need zero LLM calls).
- `llm-adapter.ts` — abstraction with two implementations: `SamplingProvider`
  (calls back through MCP sampling) and `ApiKeyProvider` (direct API call,
  CLI/CI fallback only). Nothing else in the codebase should call an LLM
  directly — always through this interface.

**Definition of done:** Given a small fixture repo, running the extractor
produces valid doc nodes for Section 2 (System Overview) and Section 3
(Getting Started) of the user guide with zero LLM calls, and content hashes
correctly detect when a fixture file changes.

**APPROVAL GATE 2** — Demo this on the fixture repo before continuing.

---

## Phase 3 — Revision-History Writer

- `revision-writer.ts` — appends rows to the Revision History table in the
  rendered document; never edits/removes existing rows.
- Each doc node also gets its own small revision log (commit SHA, what
  changed) independent of the document-level table.
- Write tests that specifically assert: regenerating a document twice with
  no code changes produces zero new revision rows, and regenerating after
  a real change produces exactly one new row with the correct commit SHA.

**Definition of done:** Tests pass for append-only behavior, including the
"no-op regeneration adds nothing" case — this is the case most likely to
silently break later.

---

## Phase 4 — MCP Server (stdio)

- `/src/mcp/server.ts` using the official MCP TypeScript SDK, stdio
  transport only.
- Expose these tools:
  - `analyze_change` — runs ast-diff + extractor on the current git diff
  - `get_contract` — returns the agent-contract facet for a given entity
  - `update_doc` — regenerates only the stale nodes/rollups affected
  - `generate_rollup` — produces a named document type from current graph
  - `get_doc_history` — returns revision history for a node or document
- Wire the LLM adapter to use MCP sampling by default when running inside
  an MCP host.
- Test locally against Claude Code only for this phase (add other hosts in
  Phase 7).

**Definition of done:** From a real Claude Code session in a test repo,
calling `analyze_change` after making a code edit returns correct results,
and `update_doc` regenerates only the affected section of the user guide.

**APPROVAL GATE 3** — Demo the MCP server working end-to-end inside Claude
Code before continuing.

---

## Phase 5 — CLI

- `/src/cli/index.ts` with commands:
  - `livingdocs scan` — run ast-diff + classify changes, no writes
  - `livingdocs update` — regenerate stale nodes/documents
  - `livingdocs generate <type>` — force-generate one document type
  - `livingdocs status` — print coverage %, stale nodes, last sync per section
- CLI uses the same core as the MCP server; the only difference is the
  LLM adapter defaults to `ApiKeyProvider` when no MCP host is present.

**Definition of done:** All four commands work against the fixture repo
from the terminal, independent of any agent.

---

## Phase 6 — Publish v0 to npm + GitHub

Do this now, even though features are incomplete — the goal is to prove the
distribution path works before building more on top of it.

1. Confirm an npm account/org named `csukmaproject` exists (create one if
   not — this is separate from the GitHub account).
2. Add `.npmignore`, verify `bin` entries resolve correctly after
   `npm pack`.
3. Publish `0.1.0` to npm as `@csukmaproject/livingdocs-mcp` — a real (not
   dry-run) release.
4. Push the GitHub repo public at `github.com/csukmaproject/livingdocs-mcp`,
   add README with:
   - what this is, in 3 sentences
   - one-line install/config snippet for Claude Code (`.mcp.json` entry
     pointing to `npx -y @csukmaproject/livingdocs-mcp`)
   - note that Codex/Cursor adapters are coming in Phase 7
5. Verify end-to-end: on a clean machine (or clean folder), add the
   `npx` config entry to Claude Code and confirm the MCP tools appear
   and work, with zero manual build steps.

**APPROVAL GATE 4** — Confirm the npm publish is ready and get explicit
go-ahead before running the actual `npm publish`.

**Definition of done:** A person with no local copy of this repo can add
one config line to Claude Code and use the tool.

---

## Phase 7 — Per-Tool Adapter Templates

- `/adapters/CLAUDE.md.template` — stanza telling Claude Code when to call
  `analyze_change` / `update_doc` / `generate_rollup`.
- `/adapters/AGENTS.md.template` — same for Codex CLI.
- `/adapters/cursor-rules.template` — same for Cursor.
- Add a table to the README: host name → config file → snippet, so a user
  picks their tool and copy-pastes one block.
- Manually verify at least the Codex CLI adapter actually works (Claude
  Code was already verified in Phase 4/6).

**Definition of done:** Both Claude Code and Codex CLI can drive the same
MCP server using only their respective adapter file.

---

## Phase 8 — Confidence Tagging + Feature/Troubleshooting Rollups

- Extend the extractor to tag every generated field `extracted` /
  `verified` / `inferred` per the Phase 1 schema.
- Build Section 4 (Core Features) and Section 5 (Troubleshooting) rollups
  — first real LLM-heavy generation, routed through `llm-adapter.ts`.
- Implement the token-efficiency rules from the plan doc: semantic
  cosmetic/contract-affecting filter, batched regeneration per commit,
  minimal dependency context (contract facet only, never full bodies),
  patch-not-rewrite on updates.
- Implement the Section 4↔5 cross-check: every custom error type should
  have a matching troubleshooting row; flag mismatches instead of silently
  dropping either side.

**Definition of done:** On the fixture repo, editing one feature function
regenerates only that feature's subsection, tags fields correctly, and
flags any error type missing from the troubleshooting table.

---

## Phase 9 — Bootstrap Pipeline (existing/undocumented repos)

- Implement the signal-source pipeline in priority order: code structure →
  tests → git history/co-change clustering → naming clustering →
  behavioral probing → LLM synthesis (always tagged `inferred`).
- `livingdocs bootstrap` CLI command: runs this pipeline, opens a PR with
  proposed annotations rather than committing directly.
- Add the "5–6 seed questions" step for business rationale — CLI prompts
  the user once, stores answers, never re-asks unless explicitly reset.

**Definition of done:** Running `livingdocs bootstrap` on the undocumented
fixture repo produces a reviewable PR with annotations and a coverage %
report, with all inferred content visibly flagged.

---

## Phase 10 — PRD / SRS / Business-Guide Rollups

- Reuse the rollup engine from Phase 2/8 with different tag filters, per
  the table in `docgen-plugin-plan.md` Section 7.
- PRD rollup needs cross-node synthesis (multiple entities per
  requirement) — scope its LLM context to just the tagged nodes.

**Definition of done:** All document types in the plan's Section 7 table
can be generated from the same doc graph via `livingdocs generate <type>`.

---

## Phase 11 — CI Integration

- `.github/workflows/livingdocs.yml`: on PR, run `livingdocs scan` and
  `livingdocs update`, post results as a PR comment (not a direct commit) —
  this is the default trust level.
- Add an opt-in config flag for auto-commit mode for teams that want it.

**Definition of done:** Opening a PR against the fixture repo produces a
bot comment listing affected doc sections, with no direct commits by
default.

---

## Phase 12 — Test Fixtures & Regression Suite

- Three fixture repos checked into `/test/fixtures`: documented,
  undocumented, greenfield.
- Deterministic extraction (Phases 2–3): exact-match tests.
- LLM-generated sections (Phases 8–10): snapshot tests with tolerance
  (structural checks — correct tags, correct sections present — rather
  than exact prose match).

**Definition of done:** `npm test` runs the full suite against all three
fixtures in CI.

---

## Phase 13 — v1 Release

- Semantic versioning from here on.
- GitHub Releases with changelog per version, published under
  `github.com/csukmaproject/livingdocs-mcp`.
- License: MIT or Apache-2.0 (confirm which with me).
- README finalized with quickstart, adapter table, and a link to
  `docgen-plugin-plan.md` for anyone wanting the full architecture
  rationale.

**APPROVAL GATE 5** — Final review before tagging `v1.0.0` and publishing.

---

## Notes for Claude Code while executing this

- Re-read `docgen-plugin-plan.md` (if present in repo) whenever a design
  question comes up rather than re-deriving architecture from scratch.
- If a phase's "Definition of done" can't be met, stop and report why
  rather than silently narrowing scope to make it pass.
- Do not skip an APPROVAL GATE even if the previous one felt uneventful.
