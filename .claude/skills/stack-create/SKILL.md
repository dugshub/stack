---
name: stack-create
description: Initialize a new PR stack from current branch or existing branches.
disable-model-invocation: true
argument-hint: [stack-name] [--from branch1 branch2 ...]
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /stack-create

Direct entry point for stack creation.

Read and follow the instructions in `.claude/skills/stack/operations/create.md`.
Load the JSON schema from `.claude/skills/stack/schema.md`.
