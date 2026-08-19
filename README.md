# livingdocs-mcp

An MCP server + CLI that keeps software documentation in permanent sync
with code, for both AI agents and humans. Documentation is derived from
code via lightweight `@purpose`/`@requirement`/`@contract`/`@audience`
annotations and a per-node content hash, not authored separately, so a
regeneration only ever touches the sections a real change actually
affects. Updates are append-only — every doc change and every revision
row is traceable to the commit that caused it.

**v1.1.1.** Extraction, `update`, and `bootstrap` work the same way across
TypeScript/JavaScript, Go, Python, and Java (see Supported languages
below), and every document type in `docgen-plugin-plan.md`'s Section 7
table generates from the same doc graph, all the way from mechanical
extraction through the bootstrap pipeline, seven MCP tools, and CI
integration. See [`CHANGELOG.md`](CHANGELOG.md) for what changed
release-by-release, and `docgen-plugin-plan.md` for the full architecture
rationale.

## Supported languages

| Language | Extensions | Doc-comment convention |
|---|---|---|
| TypeScript / JavaScript | `.ts` `.tsx` `.js` `.jsx` | JSDoc-style `/** @purpose ... */` above a declaration |
| Go | `.go` | A contiguous `//` doc-comment run (no blank line before the declaration) or a `/** ... */` block, above a declaration |
| Python | `.py` | A docstring -- the first statement inside a function/class body, or the first statement of the file for a module doc |
| Java | `.java` | Javadoc-style `/** @purpose ... */` above a class/interface/enum |

Each language is a pluggable adapter (`src/core/languages/`), so extraction,
`bootstrap`'s backfill, and every generated document work the same way
regardless of which language a repo is written in. Running `scan`/`status`
against a repo with no files in any supported language prints a clear
"No supported source files found" message (naming the extensions above)
instead of the same "No changes" message a genuinely up-to-date scan would
show -- the two cases are never conflated. A few v1 scope limits worth
knowing: only top-level declarations are recognized (methods nested inside
a Java/Python class body, or a JS/TS class's own methods, aren't extracted
individually); Go's grouped `type ( A; B )` blocks are skipped rather than
guessed at; and Java's `bootstrap` backfill doesn't yet write a
`package-info.java`-style module doc.

## Install

### Claude Code (plugin, recommended)

```
/plugin marketplace add csukmaproject/livingdocs-mcp
/plugin install livingdocs@livingdocs-mcp
```

Registers the `livingdocs` MCP server and the `livingdocs-sync` skill in
one step -- no manual `.mcp.json` edit or `CLAUDE.md` paste needed. Also
installs 7 explicit slash commands, one per function -- type
`/livingdocs:` in Claude Code to see the full list (`scan`, `status`,
`update`, `generate`, `contract`, `history`, `bootstrap`) without reading
any of this.

### Other MCP hosts

Pick your tool, add the one config line, and optionally copy the matching
adapter file from [`/adapters`](adapters) into your project so the agent
knows *when* to call the livingdocs tools rather than hand-editing
`USER_GUIDE.md`. All hosts spawn the identical local process over stdio --
nothing to host, no account, no server to keep running.

| Host | Config file | Adapter template |
|---|---|---|
| Claude Code (manual) | `.mcp.json` (project) or `claude mcp add` | [`CLAUDE.md.template`](adapters/CLAUDE.md.template) |
| Codex CLI | `codex mcp add` or `~/.codex/config.toml` | [`AGENTS.md.template`](adapters/AGENTS.md.template) |
| Cursor | `.cursor/mcp.json` | [`cursor-rules.template`](adapters/cursor-rules.template) |
| Windsurf | its MCP settings (same `mcpServers` shape) | use the Claude Code snippet as a base |

**Claude Code** — add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "livingdocs": {
      "command": "npx",
      "args": ["-y", "@csukmaproject/livingdocs-mcp"]
    }
  }
}
```

**Codex CLI** — register directly from the terminal:

```bash
codex mcp add livingdocs -- npx -y @csukmaproject/livingdocs-mcp
```

**Cursor** — add to `.cursor/mcp.json` in your project root (same shape
as Claude Code's):

```json
{
  "mcpServers": {
    "livingdocs": {
      "command": "npx",
      "args": ["-y", "@csukmaproject/livingdocs-mcp"]
    }
  }
}
```

### CLI

No install, run directly:

```bash
npx --package=@csukmaproject/livingdocs-mcp livingdocs <command>
```

Or install as a project dependency and drop `--package=...`:

```bash
npm install @csukmaproject/livingdocs-mcp
livingdocs <command>
```

## Usage

### Point it at your repo

| Your repo... | Do this |
|---|---|
| Has never used livingdocs (no `@purpose` annotations anywhere -- `status`/`get_status` shows 0% coverage) | `bootstrap` (CLI) or ask your agent to call `bootstrap_repo` (MCP) -- proposes annotations for every undocumented entity via a new branch/PR |
| Already has some or all annotations written | `update` (CLI) or ask your agent to call `update_doc` (MCP) -- regenerates only what changed |

### Commands & tools reference

Every host (and the CLI) exposes the same seven functions:

| What you want | CLI command | MCP tool | What it does |
|---|---|---|---|
| See what changed, without writing anything | `scan` | `analyze_change` | ast-diff against the current git diff; read-only |
| See coverage %, stale nodes, last sync date | `status` | `get_status` | reports doc-graph health; read-only |
| Regenerate only what's stale | `update` | `update_doc` | writes `USER_GUIDE.md` + appends a revision row |
| Force-regenerate one document type | `generate <type>` | `generate_rollup` | see Document types below |
| Look up one entity's contract | (read `USER_GUIDE.md`) | `get_contract` | preconditions/postconditions/error modes/dependencies, by nodeId or entity name |
| See when/why something last changed | -- | `get_doc_history` | revision history, per-node or document-level |
| Seed annotations into a fresh, undocumented repo | `bootstrap` | `bootstrap_repo` | see Bootstrapping an undocumented repo below |

`get_status` and `bootstrap_repo` are new in `1.1.1` -- see
[`CHANGELOG.md`](CHANGELOG.md).

### Document types

`generate <type>` (CLI) / `generate_rollup` (MCP, with `type` set to the
value shown below) force-regenerates one document type from the current
doc graph:

| Document | Generate command | Reuses | LLM |
|---|---|---|---|
| User Guide | `generate user-guide` | fixed 6-section skeleton | Sections 2-3 none, 4-5 batched per changed entity |
| Agent Contract Reference | `generate agent-contract-reference` | flat rollup of `agentContract` facets | none |
| SRS | `generate srs` | contract facets grouped by `@requirement` | none |
| Technical Guide | `generate technical-guide` | narrative facets grouped by file | none (reuses already-generated narrative) |
| Business Guide | `generate business-guide` | Technical Guide's data, filtered to `@audience:business` | optional reading-level rewrite |
| PRD | `generate prd` | cross-node synthesis across each `@requirement`'s entities | required |

From the terminal, prefix any of these with
`npx --package=@csukmaproject/livingdocs-mcp livingdocs` (or just
`livingdocs` if installed as a dependency), e.g.:

```bash
npx --package=@csukmaproject/livingdocs-mcp livingdocs generate agent-contract-reference
```

Confidence is tagged per field (`extracted`/`inferred`), and LLM calls are
always batched (one call per regeneration, not one per entity) and scoped
to only the nodes that actually changed or need that specific rollup.

### Bootstrapping an undocumented repo

`bootstrap` (CLI) / `bootstrap_repo` (MCP) runs a signal-source pipeline --
code structure, tests, git co-change history, naming, then LLM synthesis
-- to propose `@purpose`/`@contract` annotations for every undocumented
entity. On first run it asks a handful of one-time business-context
questions (skipped non-interactively, or passed as `seedAnswers` via MCP)
and never re-asks them. The proposal is committed to a new branch (opening
a PR if `origin` and an authenticated `gh` are both available) rather than
touching your checked-out branch, and every proposed line is marked
`INFERRED` in the comment itself, so nothing it guesses can be mistaken
for verified fact before you've reviewed it.

### LLM / API key behavior

MCP tools never need an API key: sampling borrows the connected host's own
model, whether that host is a CLI-based agentic tool or a desktop agentic
app -- both work the same way. The standalone CLI has no host to borrow
from, so it falls back to `ANTHROPIC_API_KEY`:

- `update` and `generate business-guide`: skipped/degraded gracefully
  without a key (the non-LLM sections still update normally).
- `generate prd` and `bootstrap`: hard-require the key, no degrade path --
  use the MCP `bootstrap_repo` tool instead of CLI `bootstrap` if you'd
  rather not provision one.

## CI

[`.github/workflows/livingdocs.yml`](.github/workflows/livingdocs.yml)
runs `livingdocs scan` and `livingdocs update` on every PR. The default
trust level posts the results as a PR comment — **no direct commit**.
Set `ci.autoCommit: true` in a `livingdocs.config.json` at your repo root
to opt into having it push the update directly to the PR branch instead:

```json
{ "ci": { "autoCommit": true } }
```

Add an `ANTHROPIC_API_KEY` repo secret to also regenerate the LLM-heavy
sections in CI (see [LLM / API key behavior](#llm--api-key-behavior)
above) — optional, everything else updates normally without it.

That workflow builds livingdocs from source, since this repo IS
livingdocs-mcp's own -- **if you're copying it into a different project**
to run livingdocs on _that_ project, swap the "build" step for
`npx -y --package=@csukmaproject/livingdocs-mcp livingdocs <command>`
instead (plain `npx -y @csukmaproject/livingdocs-mcp livingdocs
<command>`, without `--package=`, breaks: npx matches the `livingdocs-mcp`
bin by package name and swallows every arg after it, including the
`livingdocs` command word itself).

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

Fixtures live in `test/fixtures/` (`documented`, `undocumented`,
`greenfield` for TypeScript, plus a `documented-<lang>`/`undocumented-<lang>`
pair per additional language) and are exercised by both the unit tests and
the CLI integration tests, which spawn the actual built binary rather than
only testing the underlying functions. `.github/workflows/ci.yml` runs the
full suite on every push/PR.

## License

MIT — see `LICENSE`.
