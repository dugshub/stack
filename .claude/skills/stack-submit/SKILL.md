---
name: stack-submit
description: Push all stack branches and create/update PRs with stack navigation comments.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /stack-submit

Direct entry point for stack submission.

Read and follow the instructions in `.claude/skills/stack/operations/submit.md`.
Load the JSON schema from `.claude/skills/stack/schema.md`.
Load the comment template from `.claude/skills/stack/comment-template.md`.
