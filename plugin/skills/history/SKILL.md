---
description: See when and why something last changed -- per entity, or the whole document.
disable-model-invocation: true
---

# /livingdocs:history

If `$ARGUMENTS` gives a nodeId, pass it to the `get_doc_history` MCP tool
along with `repoRoot` set to the current working directory to get that
entity's revision history. Otherwise call it with no `nodeId`, which
returns the document-level revision table instead. Report the results as
a readable list, most recent first.
