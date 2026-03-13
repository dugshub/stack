# stack

CLI tool for managing stacked PRs. A Graphite replacement powered by `git`, `gh`, and good defaults.

## Install

```bash
bun install -g @dealbrain/stack
```

## Commands

| Command | Description |
|---------|-------------|
| `stack status` | Show current stack with PR statuses |
| `stack create <name>` | Create a new stack |
| `stack push` | Add current branch to active stack |
| `stack submit` | Push all branches, create/update PRs |
| `stack restack` | Cascade rebase after mid-stack edit |
| `stack sync` | Post-merge cleanup and retargeting |
| `stack nav <dir>` | Navigate up/down/top/bottom |

## How it works

Stack tracks branch relationships in `~/.claude/stacks/<repo>.json`. Each stack is an ordered array of branches. PRs are created with proper base branch targeting so GitHub shows incremental diffs.

## Built with

- [clipanion](https://github.com/arcanis/clipanion) — command routing
- [picocolors](https://github.com/alexeyraspopov/picocolors) — terminal colors
- [@clack/prompts](https://www.clack.cc/) — interactive prompts
- [cli-table3](https://www.npmjs.com/package/cli-table3) — table display
