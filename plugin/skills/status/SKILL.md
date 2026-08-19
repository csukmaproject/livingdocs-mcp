---
description: Show documentation coverage percentage, stale nodes, and last-sync date per section.
disable-model-invocation: true
---

# /livingdocs:status

Call the `get_status` MCP tool with `repoRoot` set to the current working
directory. Report `coveragePercent`, `documentedEntities` /
`totalDocumentableEntities`, the `staleNodes` list, and `sectionSyncDates`
in plain language. If coverage is 0% and there are no stale nodes, tell
the user this repo has never used livingdocs and point them at
`/livingdocs:bootstrap`.
