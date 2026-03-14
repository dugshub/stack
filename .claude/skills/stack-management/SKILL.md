---
name: stack-management
description: Auto-load PR stack context for current branch. Reads stack state and reports position. Use when working on any branch that is part of a PR stack.
user-invocable: false
allowed-tools: Bash, Read
---

# Stack Context Auto-Loader

Provides stack awareness to Claude and subagents automatically. Read-only — never modifies state.

## Steps

1. Check if `stack` CLI is available:
   ```bash
   which stack 2>/dev/null
   ```

2. If available, get stack context:
   ```bash
   stack status --json 2>/dev/null
   ```

3. If JSON output is returned, report concisely:
   ```
   Stack: <stackName> | Branch <position> of <total> | <branchName>
   ```

4. If `stack` is not installed but `.claude/` exists in the project root, suggest:
   ```
   Stack CLI not installed. Install with: bun install -g git+ssh://git@github.com/dugshub/stack.git
   Then run: stack init
   ```

5. If not on a stack branch, stay silent.

## Principles

- **Lean**: One command, concise output
- **Read-only**: Never modify state or branches
- **Silent when irrelevant**: No output if not on a stack branch
