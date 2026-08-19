---
description: Use when working in a repo with livingdocs annotations (@purpose/@requirement/@contract/@audience) -- before describing what changed in the codebase, before committing a change that touches an annotated entity, or right after such a change lands -- to keep USER_GUIDE.md and the other generated documents in sync via the livingdocs MCP tools instead of hand-editing them or re-deriving facts from source.
---

# Keep docs in sync with livingdocs

This project's documentation is kept in sync with code via the livingdocs
MCP server. Prefer its tools over hand-editing `USER_GUIDE.md` or
re-reading source to answer questions the graph already has.

- Before describing what changed in this codebase, or before committing a
  change that touches an annotated (`@purpose`/`@contract`) entity, call
  `analyze_change` to see what's stale and whether each change is
  `cosmetic` or `contract-affecting`.
- After a code change lands, call `update_doc` to regenerate only the
  affected section(s) of `USER_GUIDE.md`. Do not hand-edit that file --
  edits made outside the tool get silently overwritten on the next run.
- To answer "what's the contract for X" (preconditions, postconditions,
  error modes, dependencies), call `get_contract` with its nodeId or
  entity name instead of re-deriving it from the source.
- To force a full regeneration of one document type, call
  `generate_rollup` with `type: "user-guide"`.
- To see when and why something last changed, call `get_doc_history`
  (per-node, or document-level if no nodeId is given).
