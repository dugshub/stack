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

## Adding a New Command

1. Create `src/commands/<name>.ts`
2. Export a class extending `Command`
3. Register in `src/cli.ts`
