# Auto-Doc MCP Server — Architecture & Build Plan

## 1. Goal

An open-source tool that keeps software documentation permanently in sync
with code, for two audiences at once:

- **Agents** — need structured, queryable facts (contracts, dependencies,
  side effects) to reason about safe changes.
- **Humans** — need one readable, versioned document per project that
  explains what the system does and how to use it.

Documentation is **derived from code**, not authored separately. Updates are
**appended, never overwritten** — every change to a doc is traceable to the
commit that caused it.

**Distribution goal**: publish to GitHub as an open-source package that
anyone can install and run with their own agentic coding tool (Claude Code,
Codex CLI, Cursor, etc.) — with **no hosted infrastructure required**. See
Section 4 for how this is achieved.

---

## 2. Core Architecture

### 2.1 The Doc Graph

Every code entity (function, module, endpoint, service) becomes one **doc
node**. Nodes are connected by the same edges as the code itself (calls,
imports, data flow) — the doc graph and the code dependency graph are the
same structure, viewed differently.

Each node carries **two facets**, generated from the same extraction pass so
they can't diverge from each other:

| Facet | Audience | Content | Format |
|---|---|---|---|
| Agent-contract | Agents | signature, pre/postconditions, side effects, error modes, dependencies | structured JSON/YAML |
| Human-narrative | Humans | purpose, rationale, usage example, gotchas | prose |

### 2.2 Documents Are Rollups, Not Separate Files

PRD, SRS, technical guide, and the standardized user guide are **filtered
projections over the doc graph**, not independently written documents:

- **SRS** → rollup of agent-contract facets tagged as public interface
- **Technical guide** → rollup of human-narrative facets for entry points
- **Business guide** → same rollup, filtered to `@audience:business`, reading level adjusted
- **PRD** → rollup of `@requirement`-tagged nodes + the code entities they touch (the one place real synthesis happens, since a requirement spans multiple entities)
- **User guide** (flagship human doc) → fixed-skeleton rollup (see `user-guide-template.md`)

This is what makes "does every commit need a doc update" a non-issue — a
rollup only changes when a node carrying its tag changes.

### 2.3 Change Detection (per-node, not per-document)

1. AST-level diff (tree-sitter) detects which code entities actually changed
   — not line diffs.
2. Each doc node stores a content-hash of the code it was derived from.
   Hash mismatch → regenerate that node only.
3. Rollups re-compose from current nodes — cheap, since only changed nodes
   pass through the LLM.

### 2.4 Confidence Tagging

Every generated claim carries a visible tag:

- `extracted` — parsed directly from code/config/schema (fact)
- `verified` — confirmed by running tests or safe behavioral probes
- `inferred` — LLM guess from naming/context, unconfirmed

Rollups render `inferred` content visibly differently (e.g. flagged for
review) rather than blending it in as fact. This matters most for
undocumented repos, where most of the early content will start as
`inferred`.

### 2.5 Versioning — Append, Never Replace

Two layers, both backed by git as ground truth:

- **Per-node history**: small revision log per doc node (commit SHA, what
  changed, timestamp).
- **Per-document Revision History table**: appended row per regeneration,
  visible at the top of the rendered document. Never edits a previous row.

No `doc-v1.md`, `doc-v2.md` files — one canonical file per doc type, git and
the in-document table carry the versions.

---

## 3. Bootstrap Strategy (existing / undocumented repos)

Most real repos have no prior docs, annotations, or requirement tracking.
Signal sources, in order of reliability:

1. **Code structure** — types, schemas, API defs, migrations (deterministic, no LLM)
2. **Tests** — assertions are executable specs; mine before inferring anything
3. **Git history** — commit messages + co-change clustering → candidate feature groupings
4. **Naming/domain clustering** — identifier clusters → candidate bounded contexts
5. **Behavioral probing** — run untested code against generated inputs to observe real behavior
6. **LLM synthesis** — last resort, always tagged `inferred`, routed to human review before being treated as canonical

**The honest gap**: business rationale ("why does this rule exist") often
has no trace in code. Fix: collect it once via 5–6 short questions to a
human at bootstrap time, not by having the LLM invent plausible-sounding
justifications. Everything else regenerates automatically after that seed.

Sequencing for a brand-new project vs. an existing one:

- **New project**: annotations (`@purpose`, `@requirement`, `@contract`,
  `@audience`) are written alongside code from day one. No bootstrap needed.
- **Existing project**: pilot a high-change-frequency slice first (mine git
  log for churn + call-graph centrality), bootstrap-annotate via
  LLM-proposed PR (human-reviewed), then ratchet — new/changed code must be
  annotated in CI, legacy coverage expands opportunistically as files get
  touched. This runs identically regardless of which agentic tool triggers
  it, since it's core-library logic, not something tied to a specific host.

---

## 4. Distribution Model — Zero Infrastructure

This is the piece that determines whether "publish to GitHub, anyone can
run it" is actually true. The key design choice: **the MCP server runs
locally, as a short-lived subprocess spawned by the user's own agent** — it
is not a hosted service you run or pay for.

### 4.1 How MCP servers normally run (no hosting needed)

MCP has two transport types:

- **stdio** (local): the host agent (Claude Code, Codex CLI, Cursor, etc.)
  launches your server as a child process on the user's own machine and
  talks to it over stdin/stdout. This is the default for developer tools
  and is what this project uses. **Nobody hosts anything** — the server
  only exists while the agent session is running, on the user's own
  hardware, using the user's own filesystem access to their repo.
- **HTTP/SSE** (remote): for a server that runs continuously somewhere and
  serves multiple users/sessions — genuinely needs infrastructure (a
  deployed process, uptime, auth). **Not needed for this project** and
  explicitly out of scope for v1. It only becomes relevant later if there's
  demand for a shared/hosted variant (e.g. a team-wide dashboard) — a
  separate, optional add-on, not a prerequisite for launch.

### 4.2 What "publish to GitHub" actually means here

1. Open-source the repo on GitHub — code + README + license.
   **Confirmed location: `github.com/csukmaproject/livingdocs-mcp`.**
2. Publish the built package to the **npm registry** under a scoped name.
   **Confirmed name: `@csukmaproject/livingdocs-mcp`** (available as of the
   last check; requires an npm account/org named `csukmaproject` — separate
   from the GitHub account, create this before Phase 6 of the build brief).
3. Users add one entry to their agent's MCP config pointing at
   `npx -y @csukmaproject/livingdocs-mcp`. The agent handles fetching and
   running it on demand — no install step, no server to keep alive, no
   account on their side.

That's the entire "infrastructure": a GitHub repo and an npm package. Both
are free, and neither requires you to run or maintain a server.

### 4.3 What each host's config entry looks like (all local, all stdio)

- **Claude Code** — `.mcp.json` in the project or `claude mcp add` CLI command, command: `npx -y @csukmaproject/livingdocs-mcp`
- **Codex CLI** — entry in its MCP config pointing at the same npx command
- **Cursor / Windsurf** — same pattern in their respective MCP settings

All of them spawn the identical local process. You maintain one config
snippet per host as a template in the README, not separate infrastructure
per host.

### 4.4 CI/headless path (also no hosting)

For GitHub Actions or git hooks, the **CLI** (same core library, no MCP
transport involved) runs directly in the CI runner, using a provided API
key for LLM calls. Still nothing to host — it's a step in someone else's
pipeline, not a service of yours.

---

## 5. Tech Stack

- **Core library**: TypeScript/Node, framework- and agent-agnostic.
  Contains AST diff (tree-sitter), the doc graph + hash store, extraction
  pipeline, and rollup engine. No agent-specific code lives here.
- **MCP server**: thin stdio wrapper around the core, exposes tools such as
  `get_contract`, `analyze_change`, `update_doc`, `generate_rollup`,
  `get_doc_history`. Ships inside the same npm package as the core.
- **Model access via MCP sampling, not a bundled API key**: the server asks
  the *host agent's own connected model* to run completions, rather than
  requiring its own provider credentials. This is what makes "runs on any
  agentic tool" true rather than aspirational — the server borrows
  whichever model the user's agent is already using (Anthropic, OpenAI,
  local, etc.). A direct API key is only needed as a fallback for the
  headless CLI/CI path, where there's no host model to borrow from.
- **CLI**: thin wrapper around the same core, for git hooks and CI
  pipelines where no MCP host is present.
- **Storage**: markdown files + hidden hash-comment metadata, committed to
  the repo itself. No external database, no server-side state.

---

## 6. Cross-Agent Compatibility

MCP is the interoperability layer — it replaces the need for separate
integrations per agentic tool, and (per Section 4) it does this without
requiring you to host anything.

- **One package, many hosts.** Claude Code, Codex CLI, Cursor, Windsurf,
  and others speak MCP already. Registering the server is a config-file
  entry on the host side, not a code change on your side.
- **Sampling keeps it model-agnostic.** Completions run through the host's
  own connected model via MCP sampling, so the server never forces a
  specific provider on the user.
- **Per-tool adapters are the only tool-specific artifact**, and they're
  small: a short stanza in CLAUDE.md, AGENTS.md, `.cursor/rules`, etc.,
  telling that agent when to call `analyze_change` / `update_doc` /
  `generate_rollup`. These ship as templates in the repo, one file each.

---

## 7. Document Types Shipped

| Type | Primary audience | Generation mode |
|---|---|---|
| Agent contract reference | Agents | Structured extraction, low LLM use |
| SRS | Technical/agents | Rollup of contract facets |
| PRD | Product/business | Rollup + synthesis across requirement-tagged nodes |
| Technical guide | Developers | Rollup of narrative facets, entry points |
| Business guide | Non-technical stakeholders | Same rollup, reading level adjusted |
| **User guide (flagship, single file)** | Humans, all levels | Fixed 6-section skeleton |

---

## 8. Build Roadmap

1. **Freeze the two schemas first**: the annotation tag vocabulary
   (`@purpose` / `@requirement` / `@contract` / `@audience`) and the
   doc-node JSON schema. Every later stage depends on these being stable.
2. **Core library**: AST diff, doc graph + hash store, extraction pipeline,
   rollup engine, LLM abstraction (sampling-first, API-key fallback).
   Validate with the mechanical, no-LLM sections first (user guide
   sections 2–3).
3. **Revision-history writer**: get the append-not-replace mechanism solid
   before adding more sections — the riskiest piece of plumbing.
4. **MCP server (stdio)**: wrap the core with `get_contract`,
   `analyze_change`, `update_doc`, `generate_rollup`, `get_doc_history`.
   Test locally with one host (Claude Code) before adding others.
5. **CLI**: thin wrapper over the same core for git hooks / CI.
6. **Publish v0 to npm + GitHub**: this is what unlocks `npx` installs —
   do this early, even before every feature is done, so the distribution
   path itself is tested and working.
7. **Per-tool adapter templates**: CLAUDE.md, AGENTS.md, `.cursor/rules`
   stanzas, plus each host's MCP registration snippet, documented in the
   README as copy-paste config.
8. **Confidence tagging + feature/troubleshooting rollups**: first
   real LLM-heavy generation, built on the now-stable core.
9. **Bootstrap pipeline**: reverse-extraction for existing/undocumented
   repos (Section 3).
10. **PRD/SRS/business-guide rollups**: reuse the same doc graph, different
    filters.
11. **CI integration**: GitHub Action calling the CLI, PR-comment mode as
    the default trust level before enabling auto-merge.
12. **Test fixtures**: three sample repos (documented, undocumented,
    greenfield) as the regression suite.
13. **v1 release**: semantic versioning, GitHub Releases with changelog,
    npm package tagged `latest`. License MIT or Apache-2.0.

---

## 9. Token Efficiency (without degrading quality)

Efficiency has to be won at the pipeline-stage level, not by trimming the
content the model actually needs to reason about.

### 9.1 Scanning — near-zero cost
- AST diff detects *what* changed; no LLM involved.
- **Semantic filter before anything reaches the model**: classify each
  changed node as *cosmetic* (rename, reformat, comment-only) vs
  *contract-affecting* (signature, return type, error path, dependency).
  Only contract-affecting changes proceed.
- Hash-skip unchanged nodes entirely.

### 9.2 Deciding what to regenerate
- **Batch** related changed nodes from the same commit/PR into one call.
- **Minimal dependency context**: inject only the *contract facet*
  (signature + one-line purpose) of dependencies, never their full bodies.
- **Prompt caching** for the template skeleton, tag vocabulary, and output
  schema — identical across nearly every call.

### 9.3 Generation — tier the model to the task
- Mechanical extraction: no LLM.
- Contract-facet inference: smaller/cheaper model.
- Narrative prose and PRD-level cross-node synthesis: reserve the larger
  model.
- On updates, **patch existing narrative against the diff** rather than
  rewrite from scratch.

### 9.4 Rollup assembly — should be nearly free
- Rollups are deterministic templating/concatenation of already-generated
  node content, not a fresh LLM pass over the whole document.
- Exception: genuine cross-node synthesis (the PRD) — scope input to just
  the tagged nodes, not the full graph.

### 9.5 Where not to cut
- Never trim the code of the node actually being generated — trim
  *dependency* context instead.
- Never skip human review to save cost.

---

## 10. Additional Capabilities (prioritized)

1. **Doc linting in CI, independent of generation** — flags dangling
   references even on commits that didn't trigger regeneration.
2. **Auto-generated diagrams (Mermaid)** — render the dependency graph
   directly into architecture/sequence diagrams at zero LLM cost.
3. **Executable doc examples** — link each code snippet to a real test. A
   passing test upgrades a snippet from `inferred` to `verified`.
4. **Coverage/staleness dashboard** — % of codebase annotated and "days
   since last sync" per section.
5. **PR-comment mode as a lighter default** — post affected sections as a
   PR comment instead of committing doc changes directly.
6. **Config-driven custom templates** — `livingdocs.config.yaml` lets teams
   swap in their own section skeleton.
7. **Multi-service/monorepo rollups** — a cross-service view for systems
   that span multiple services/repos.

---

## 11. Open Questions to Resolve Before Building

- Annotation tag vocabulary — finalize syntax before writing the extractor.
- How much human-in-the-loop is default vs. opt-in for auto-merging doc
  updates (recommended default: PR-based review, not direct commit).
- Whether the doc graph should be exposed as a queryable structure to other
  tools later, as an optional add-on — not required for v1.
- Which hosts to validate against for the v1 release (recommend: Claude
  Code + Codex CLI as the two launch targets, others added as adapter
  templates once the core is stable).
