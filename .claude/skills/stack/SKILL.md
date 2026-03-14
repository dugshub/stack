---
name: stack
description: Manage PR stacks — create, push, submit, restack, sync, navigate. Use when user mentions stacks, stacked PRs, restack, stack submit, or branch dependencies.
argument-hint: [create|push|submit|restack|sync|nav|status]
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /stack — PR Stack Management

Replace for Graphite. Manages PR stacks using `gh` CLI + `git` directly.

## Usage

```
/stack                     # show current stack status
/stack create [name]       # initialize new stack
/stack push                # add current branch to top of active stack
/stack submit              # push all + create/update PRs + comments
/stack restack             # cascade rebase after mid-stack edit
/stack restack --continue  # resume after resolving conflicts
/stack sync                # retarget after PR merge
/stack nav up|down         # navigate stack
```

## How It Works

- Stack state persisted at `~/.claude/stacks/<repo>.json`
- Uses `gh` CLI for all GitHub operations (PRs, comments)
- Uses `git rebase --onto` for restacking
- Worktree-aware — restacks across worktrees by cd-ing into each
- Multiple independent stacks supported simultaneously

## Branch Naming Convention

Suggested: `<username>/<stack-name>/<n>-<description>`

Example: `doug/frozen-column/1-sticky-header`, `doug/frozen-column/2-scroll-shadow`

## Operations

Based on the subcommand (from `$ARGUMENTS`), read and follow the appropriate operation file:

| Subcommand | Operation File |
|------------|---------------|
| (none) or `status` | `$CLAUDE_SKILL_DIR/operations/status.md` |
| `create` | `$CLAUDE_SKILL_DIR/operations/create.md` |
| `push` | `$CLAUDE_SKILL_DIR/operations/push.md` |
| `submit` | `$CLAUDE_SKILL_DIR/operations/submit.md` |
| `restack` | `$CLAUDE_SKILL_DIR/operations/restack.md` |
| `sync` | `$CLAUDE_SKILL_DIR/operations/sync.md` |
| `nav` | `$CLAUDE_SKILL_DIR/operations/nav.md` |

**Before executing any operation:**
1. Read `$CLAUDE_SKILL_DIR/schema.md` to understand the JSON data model
2. Read the relevant operation file
3. If the operation modifies PR comments, also read `$CLAUDE_SKILL_DIR/comment-template.md`

## Stack JSON Location

```bash
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
STACK_FILE="$HOME/.claude/stacks/${REPO_NAME}.json"
```

If the file does not exist, initialize it:
```json
{
  "repo": "<owner>/<repo>",
  "stacks": {}
}
```

Determine `<owner>/<repo>` from: `gh repo view --json nameWithOwner --jq '.nameWithOwner'`

## Active Stack Detection

The active stack is inferred — not stored:
1. `git branch --show-current` to get current branch
2. Search all stacks for a branch entry matching the current branch
3. If found, that stack is active and the branch index is the current position
