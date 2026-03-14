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

## When to use proactively

- When implementing features across multiple PRs, use `stack create` + `stack push` to organize branches
- After amending commits mid-stack, run `stack restack` to cascade changes
- Before asking for review, run `stack submit` to push and create/update all PRs
