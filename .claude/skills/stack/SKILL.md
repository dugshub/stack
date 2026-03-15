---
name: stack
description: Manage PR stacks — create, push, submit, restack, sync, navigate. Use when user mentions stacks, stacked PRs, restack, stack submit, or branch dependencies.
argument-hint: [create|push|submit|restack|sync|nav|status]
allowed-tools: Bash, Read
---

# /stack — PR Stack Management

Thin wrapper around the `stack` CLI. All operations delegate to the CLI binary.

## Usage

```
/stack                     # show current stack status
/stack create [name]       # initialize new stack
/stack push                # add current branch to top of active stack
/stack submit              # push all + create/update PRs + comments
/stack submit --dry-run    # preview what submit would do
/stack restack             # cascade rebase after mid-stack edit
/stack restack --continue  # resume after resolving conflicts
/stack sync                # retarget after PR merge
/stack nav up|down|top|bottom  # navigate stack
/stack split --dry-run "name:pattern" ...  # preview splitting dirty tree into stack
/stack split --name <stack> "name:pattern" ...  # execute the split
/stack merge --dry-run     # preview cascade merge plan
/stack merge --all         # cascade merge entire stack via webhooks
/stack merge --status      # check active merge job
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
2. **Execute**: `stack merge --all` (requires webhook server + branch protection)
3. **Monitor**: `stack merge --status`

## When to use proactively

- When implementing features across multiple PRs, use `stack create` + `stack push` to organize branches
- After amending commits mid-stack, run `stack restack` to cascade changes
- Before asking for review, run `stack submit` to push and create/update all PRs
- After a large implementation task, use `stack split` to break changes into reviewable PRs
- When all PRs are approved, use `stack merge --all` to cascade merge
