---
name: stack
description: Manage PR stacks — create, track, submit, restack, sync, merge, split, navigate, undo, and more. Use when user mentions stacks, stacked PRs, restack, stack submit, merge, split, or branch dependencies.
argument-hint: [create|track|submit|restack|sync|merge|split|nav|status|absorb|undo|delete|remove|init|update]
allowed-tools: Bash, Read
---

# /stack — PR Stack Management

Thin wrapper around the `stack` CLI. All operations delegate to the CLI binary.

## Commands Reference

### Stack lifecycle
```
stack create [name]               # Start a new stack (interactive if no name)
stack create [name] -d <desc>     # Create with first branch description
stack create --from b1 b2 b3      # Adopt existing branches into a stack
stack delete [name]               # Remove stack from tracking
stack delete [name] --branches    # Also delete local + remote git branches
stack delete [name] --prs         # Also close open PRs
stack init                        # Install Claude Code skills into current project
stack update                      # Self-update to latest version from GitHub
```

### Branch management
```
stack track                       # Add current branch to active stack
stack track -s <stack>            # Add to a specific stack
stack remove [branch]             # Remove branch from stack (defaults to current)
stack remove [branch] --branch    # Also delete the git branch
stack remove [branch] --pr        # Also close the PR
stack nav up|down|top|bottom      # Navigate between stack branches
stack nav <number>                # Jump to branch by index
stack nav                         # Interactive branch picker
```

### Working with changes
```
stack status                      # Show current stack and PR status
stack status -s <stack>           # Show a specific stack
stack status --json               # Machine-readable JSON output
stack submit                      # Push all branches, create/update PRs
stack submit -s <stack>           # Submit a specific stack
stack submit --dry-run            # Preview what submit would do
stack restack                     # Cascade rebase after mid-stack edit
stack continue                    # Resume after resolving conflicts
stack abort                       # Abort in-progress restack
stack absorb                      # Route uncommitted fixes to correct stack branches
stack absorb --dry-run            # Preview file routing plan
stack absorb -m "message"         # Commit message for absorbed changes
stack absorb -s <stack>           # Target a specific stack
stack undo                        # Restore state to before last mutating command
stack undo --steps 3              # Undo multiple operations
stack undo --list                 # Show available restore points
stack undo --dry-run              # Preview what would change
```

### Split workflow (large changes → stacked PRs)
```
stack split --dry-run "desc:pattern" ...          # Preview split plan
stack split --name <stack> "desc:pattern" ...     # Execute the split
```

### Merge workflow (merge entire stack)
```
stack merge --dry-run             # Preview cascade merge plan
stack merge --all                 # Merge entire stack bottom-up via webhooks
stack merge --status              # Check active merge job status
stack merge --setup               # Configure webhook secret and server
```

### Sync after merges
```
stack sync                        # Remove merged branches, rebase remaining
stack sync -s <stack>             # Sync a specific stack
```

## Execution

Run the CLI command directly. Pass through all arguments from `$ARGUMENTS`:

```bash
stack $ARGUMENTS
```

If `$ARGUMENTS` is empty, run `stack status`.

If `stack` is not found (command not found), tell the user to install it:

```bash
bun install -g git+ssh://git@github.com/dugshub/stack.git
```

## Workflows

### Split workflow (large batch of changes → stacked PRs)

When you have a large set of uncommitted changes to split into a stack:

1. **Inventory**: Run `git diff --stat` and `git status` to see all changes
2. **Draft split**: Group files by dependency layer / logical unit
3. **Preview**: `stack split --dry-run --name <name> "branch:pattern" ...`
4. **Check balance**: Look at +/- stats. If any branch is 2x+ the median, break it up further.
5. **Iterate**: Adjust patterns and re-run `--dry-run` until balanced
6. **Execute**: Remove `--dry-run` to create the stack
7. **Submit**: `stack submit` to push and create PRs

**Pattern syntax:** `branch-name:glob[:glob...]` — use `!` prefix for negation.

### Merge workflow (merge entire stack)

1. **Preview**: `stack merge --dry-run`
2. **Execute**: `stack merge --all` (requires branch protection + webhook server)
3. **Monitor**: `stack merge --status` or watch the live TUI

### Sync after merge

After one or more PRs in a stack are merged on GitHub:

1. **Sync**: `stack sync` — removes merged branches, retargets remaining PRs, rebases
2. If all PRs were merged, the stack is automatically cleaned up

### Undo mistakes

1. **List restore points**: `stack undo --list`
2. **Preview**: `stack undo --dry-run`
3. **Undo**: `stack undo` (or `stack undo --steps N` for multiple)

## When to use proactively

- When implementing features across multiple PRs, use `stack create` + `stack track` to organize branches
- After amending commits mid-stack, run `stack restack` to cascade changes
- Before asking for review, run `stack submit` to push and create/update all PRs
- After a large implementation task, use `stack split` to break changes into reviewable PRs
- When all PRs are approved, use `stack merge --all` to cascade merge
- After merges land on GitHub, use `stack sync` to clean up
- If something goes wrong, use `stack undo` to restore previous state
