---
description: Look up one entity's agent contract -- preconditions, postconditions, error modes, dependencies.
disable-model-invocation: true
---

# /livingdocs:contract

If `$ARGUMENTS` gives a nodeId (`filePath#entityName:entityType`) or an
entity name, use it. Otherwise ask the user which entity they mean. Call
the `get_contract` MCP tool with `repoRoot` set to the current working
directory and either `nodeId` or `entityName` set accordingly. Report the
`agentContract` fields (preconditions, postconditions, side effects, error
modes, dependencies) in plain language.
