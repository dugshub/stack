# Contributing

## Architecture

The CLI is built with clipanion and organized as:

```
src/
  cli.ts          — entry point
  commands/       — one file per command
  lib/            — shared utilities
```

## Commands Overview

All commands follow the same pattern:
1. Load state from `~/.claude/stacks/<repo>.json`
2. Perform git/gh operations
3. Save state
4. Report results

## Submit Workflow

The submit command is the most important command. It:

1. Pushes all branches with `--force-with-lease`
2. Creates PRs with proper base branch targeting
3. Posts stack navigation comments

## PR Title Derivation

Titles are derived from branch names automatically:
- `dugshub/my-stack/1-add-schema` → "Add Schema"
- Falls back to last commit subject if branch name doesn't match convention

## Adding a New Command

1. Create `src/commands/<name>.ts`
2. Export a class extending `Command`
3. Register in `src/cli.ts`

## Testing Changes

Always run `stack submit --dry-run` before submitting to verify the plan.
