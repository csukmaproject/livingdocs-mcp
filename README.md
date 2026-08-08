# livingdocs-mcp

An MCP server + CLI that keeps software documentation in permanent sync
with code, for both AI agents and humans. Documentation is derived from
code via lightweight `@purpose`/`@requirement`/`@contract`/`@audience`
annotations and a per-node content hash, not authored separately, so a
regeneration only ever touches the sections a real change actually
affects. Updates are append-only — every doc change and every revision
row is traceable to the commit that caused it.

Status: v0.1.0. Core extraction, revision history, the MCP server (5
tools), and the CLI (4 commands) are implemented against the User Guide's
System Overview and Getting Started sections; confidence tagging and the
richer rollups (Core Features, Troubleshooting, PRD, SRS, business guide)
land in later phases. See `docgen-plugin-plan.md` for the full
architecture rationale.

## Install

```bash
npm install @csukmaproject/livingdocs-mcp
```

## Use with an AI coding agent (MCP)

| Host | Config file | Snippet |
|---|---|---|
| Claude Code | `.mcp.json` (project) or `claude mcp add` | see below |
| Codex CLI, Cursor, Windsurf | their respective MCP settings | coming in Phase 7 |

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

This exposes five tools to the agent: `analyze_change`, `get_contract`,
`update_doc`, `generate_rollup`, and `get_doc_history`. No install step,
no server to keep running, no account — the agent spawns and talks to it
over stdio for the duration of the session.

## Use from the terminal (CLI)

The CLI binary is named `livingdocs` and ships in this same package:

```bash
npx --package=@csukmaproject/livingdocs-mcp livingdocs scan
npx --package=@csukmaproject/livingdocs-mcp livingdocs update
npx --package=@csukmaproject/livingdocs-mcp livingdocs generate user-guide
npx --package=@csukmaproject/livingdocs-mcp livingdocs status
```

Once installed as a project dependency, you can drop the `--package` and
just run `livingdocs <command>`.

## License

MIT — see `LICENSE`.
