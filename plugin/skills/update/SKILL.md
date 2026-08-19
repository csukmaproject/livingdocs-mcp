---
description: Regenerate only the stale sections of USER_GUIDE.md.
disable-model-invocation: true
---

# /livingdocs:update

Call the `update_doc` MCP tool with `repoRoot` set to the current working
directory. Report which sections changed, whether a revision row was
added, and any `crossCheck` warnings. If nothing changed, say so plainly
("Already up to date") rather than restating an empty result.
