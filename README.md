# livingdocs-mcp

An MCP server + CLI that keeps software documentation in permanent sync
with code, for both AI agents and humans. Documentation is derived from
code via lightweight `@purpose`/`@requirement`/`@contract`/`@audience`
annotations and a per-node content hash, not authored separately, so a
regeneration only ever touches the sections a real change actually
affects. Updates are append-only — every doc change and every revision
row is traceable to the commit that caused it.

Status: v0.1.0. Core extraction, revision history, the MCP server (5
tools), the CLI (5 commands: scan/update/generate/status/bootstrap), and
every document type from docgen-plugin-plan.md's Section 7 table are
implemented, all reusing the same doc graph:

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
to only the nodes that actually changed or need that specific rollup. See
`docgen-plugin-plan.md` for the full architecture rationale.

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

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

Fixtures live in `test/fixtures/` (`documented`, `undocumented`) and are
exercised by both the unit tests and the CLI integration tests, which
spawn the actual built binary rather than only testing the underlying
functions.

## License

MIT — see `LICENSE`.
