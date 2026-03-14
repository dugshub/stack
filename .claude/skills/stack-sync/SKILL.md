---
name: stack-sync
description: Retarget and rebase after a stacked PR merges into trunk.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /stack-sync

Direct entry point for post-merge stack synchronization.

Read and follow the instructions in `.claude/skills/stack/operations/sync.md`.
Load the JSON schema from `.claude/skills/stack/schema.md`.
Load the comment template from `.claude/skills/stack/comment-template.md`.
