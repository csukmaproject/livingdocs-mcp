---
description: Check what's changed in this repo since the last livingdocs scan, without writing anything.
disable-model-invocation: true
---

# /livingdocs:scan

Call the `analyze_change` MCP tool with `repoRoot` set to the current
working directory (ask the user for a path if it's unclear which repo
they mean). Report `usedGitScoping` and the list of `changes`, grouped by
classification (`cosmetic` vs `contract-affecting`), in plain language. If
`changes` is empty, say so plainly ("No changes since last scan").
