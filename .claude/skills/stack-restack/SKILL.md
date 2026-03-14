---
name: stack-restack
description: Cascade rebase downstream branches after editing a branch mid-stack.
disable-model-invocation: true
argument-hint: [--continue]
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /stack-restack

Direct entry point for restacking.

Read and follow the instructions in `.claude/skills/stack/operations/restack.md`.
Load the JSON schema from `.claude/skills/stack/schema.md`.
