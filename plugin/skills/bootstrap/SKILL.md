---
description: Seed initial @purpose/@contract annotations into a fresh, undocumented repo. Mutates the repo -- confirm before running.
disable-model-invocation: true
---

# /livingdocs:bootstrap

This mutates the repo: it commits proposed annotations to a new branch
(never the current checked-out branch) and, if `origin` and an
authenticated `gh` are both available, pushes and opens a PR. **Tell the
user what this is about to do and confirm before calling the tool.**

Optionally offer to ask the user the six business-context seed questions
listed in the `bootstrap_repo` tool's own description, to sharpen the
inferred annotations -- skip this if they'd rather not answer, in which
case annotations are inferred from code/test/git signals alone. Then call
`bootstrap_repo` with `repoRoot` set to the current working directory and
`seedAnswers` set to their answers if collected. Report the branch name,
the number of proposed entities, and the PR URL (or push/manual-push
status) from the result.
