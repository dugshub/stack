---
name: stack-management
description: Auto-load PR stack context for current branch. Reads stack state and reports position. Use when working on any branch that is part of a PR stack.
user-invocable: false
allowed-tools: Bash, Read
---

# Stack Context Loader

Automatically provides stack awareness to Claude and subagents.

## Instructions

1. Get current branch and repo:
   ```bash
   CURRENT_BRANCH=$(git branch --show-current)
   REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
   ```

2. Read stack state from `~/.claude/stacks/${REPO_NAME}.json`. If the file does not exist, there are no active stacks — stop here silently.

3. Search all stacks for a branch entry matching `$CURRENT_BRANCH`.

4. If found, report concisely:
   ```
   Stack: <stack-name> | Branch <position> of <total> | Upstream: <parent-branch> | Downstream: <child-branch>
   PRs: #101 → #102 → #103 (current: #102)
   ```

5. If a `restackState` is present on the stack, warn:
   ```
   ⚠ Restack in progress — resolve conflicts and run `/stack restack --continue`
   ```

6. If not found in any stack, stay silent — don't report anything.

## Key Principle

This skill is **read-only** and **lean**. It never modifies the stack JSON. It exists solely to orient Claude (and subagents with `skills: [stack-management]`) within the stack topology.
