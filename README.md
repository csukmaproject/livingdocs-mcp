# livingdocs-mcp

An MCP server + CLI that keeps software documentation in permanent sync
with code, for both AI agents and humans. Documentation is derived from
code via lightweight `@purpose`/`@requirement`/`@contract`/`@audience`
annotations and a per-node content hash, not authored separately, so a
regeneration only ever touches the sections a real change actually
affects. Updates are append-only — every doc change and every revision
row is traceable to the commit that caused it.

**v1.0.0.** Every document type in `docgen-plugin-plan.md`'s Section 7
table generates from the same doc graph, all the way from mechanical
extraction through the bootstrap pipeline and CI integration. See
[`CHANGELOG.md`](CHANGELOG.md) for what changed since `0.1.0`, and
`docgen-plugin-plan.md` for the full architecture rationale.

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

## Quickstart

```bash
# 1. In an already-annotated (or freshly bootstrapped) repo:
npx --package=@csukmaproject/livingdocs-mcp livingdocs update

# 2. Or hand it to an AI coding agent instead of running the CLI yourself --
#    add to .mcp.json (Claude Code) or the equivalent for your host:
```
```json
{ "mcpServers": { "livingdocs": { "command": "npx", "args": ["-y", "@csukmaproject/livingdocs-mcp"] } } }
```
```bash
# 3. Existing, undocumented repo? Bootstrap it first:
npx --package=@csukmaproject/livingdocs-mcp livingdocs bootstrap
```

This exposes six document types (`generate <type>`, or the MCP
`generate_rollup` tool): the flagship User Guide, Agent Contract
Reference, SRS, PRD, Technical Guide, and Business Guide, all reusing the
same doc graph:

| Document | Reuses | LLM |
|---|---|---|
| User Guide (`generate user-guide`) | fixed 6-section skeleton | Sections 2-3 none, 4-5 batched per changed entity |
| Agent Contract Reference | flat rollup of `agentContract` facets | none |
| SRS | contract facets grouped by `@requirement` | none |
| Technical Guide | narrative facets grouped by file | none (reuses already-generated narrative) |
| Business Guide | Technical Guide's data, filtered to `@audience:business` | optional reading-level rewrite |
| PRD | cross-node synthesis across each `@requirement`'s entities | required |

Confidence is tagged per field (`extracted`/`inferred`), and LLM calls are
always batched (one call per regeneration, not one per entity) and scoped
to only the nodes that actually changed or need that specific rollup.

## Install

```bash
npm install @csukmaproject/livingdocs-mcp
```

## Use with an AI coding agent (MCP)

All hosts spawn the identical local process over stdio -- nothing to
host, no account, no server to keep running. Pick your tool, add the one
config line, and optionally copy the matching adapter file from
[`/adapters`](adapters) into your project so the agent knows *when* to
call `analyze_change` / `update_doc` / `generate_rollup` rather than
hand-editing `USER_GUIDE.md`.

| Host | Config file | Adapter template |
|---|---|---|
| Claude Code | `.mcp.json` (project) or `claude mcp add` | [`CLAUDE.md.template`](adapters/CLAUDE.md.template) |
| Codex CLI | `codex mcp add` or `~/.codex/config.toml` | [`AGENTS.md.template`](adapters/AGENTS.md.template) |
| Cursor | `.cursor/mcp.json` | [`cursor-rules.template`](adapters/cursor-rules.template) |
| Windsurf | its MCP settings (same `mcpServers` shape) | use the Claude Code snippet as a base |

### Claude Code: install as a plugin (recommended)

    /plugin marketplace add csukmaproject/livingdocs-mcp
    /plugin install livingdocs@livingdocs-mcp

This registers the `livingdocs` MCP server and installs the
`livingdocs-sync` skill (same guidance as
[`CLAUDE.md.template`](adapters/CLAUDE.md.template)) in one step -- no
manual `.mcp.json` edit or `CLAUDE.md` paste needed. Use the manual route
below instead if you do not use Claude Code's plugin system, want to pin an
exact commit/tag, or use a different host.

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

Every host exposes the same five tools: `analyze_change`, `get_contract`,
`update_doc`, `generate_rollup`, and `get_doc_history`.

## Use from the terminal (CLI)

The CLI binary is named `livingdocs` and ships in this same package:

```bash
npx --package=@csukmaproject/livingdocs-mcp livingdocs scan
npx --package=@csukmaproject/livingdocs-mcp livingdocs update
npx --package=@csukmaproject/livingdocs-mcp livingdocs generate user-guide
npx --package=@csukmaproject/livingdocs-mcp livingdocs generate srs
npx --package=@csukmaproject/livingdocs-mcp livingdocs generate prd
npx --package=@csukmaproject/livingdocs-mcp livingdocs status
npx --package=@csukmaproject/livingdocs-mcp livingdocs bootstrap
```

Once installed as a project dependency, you can drop the `--package` and
just run `livingdocs <command>`.

`bootstrap` is for existing, undocumented repos: it runs a signal-source
pipeline (code structure, tests, git co-change history, naming, then LLM
synthesis) to propose annotations for every undocumented entity, asks a
handful of one-time business-context questions on first run, and commits
the proposal to a new branch (opening a PR if `origin` + an authenticated
`gh` are available) rather than touching your checked-out branch. Every
proposed line is marked `INFERRED` in the comment itself, so nothing it
guesses can be mistaken for verified fact before you've reviewed it.

There's no MCP host to borrow a model from out here, so `update` and
`generate` fall back to a direct API key for the Core Features /
Troubleshooting sections: set `ANTHROPIC_API_KEY` in your environment, or
they're skipped (the other sections still update normally).

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
Core Features / Troubleshooting sections in CI — optional, everything
else updates normally without it.

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
