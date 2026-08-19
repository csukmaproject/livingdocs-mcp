---
description: Force-regenerate one document type -- user-guide, agent-contract-reference, srs, technical-guide, business-guide, or prd.
disable-model-invocation: true
---

# /livingdocs:generate

If `$ARGUMENTS` already names one of the six type values below, use it
directly. Otherwise, present this table and ask the user which one they
want before proceeding:

| Type value | Document |
|---|---|
| `user-guide` | User Guide (fixed 6-section skeleton) |
| `agent-contract-reference` | Agent Contract Reference |
| `srs` | SRS |
| `technical-guide` | Technical Guide |
| `business-guide` | Business Guide |
| `prd` | PRD |

Then call the `generate_rollup` MCP tool with `repoRoot` set to the
current working directory and `type` set to the chosen value. Report the
output path and any `crossCheck` warnings.
