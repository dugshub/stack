# Stack Recovery

What to do when something goes sideways. `st undo` is the universal escape hatch — a snapshot is saved before every mutating command (`sync`, `restack`, `modify`, `absorb`, `split`, `fold`, `insert`, `move`, `reorder`, `remove`, `base`).

## Rebase conflict during restack / modify / fold / base

Git pauses with conflict markers. The stack is in a `restackState`-paused state.

```bash
# 1. edit the conflicting files to resolve
# 2. stage them
git add <resolved-files>
# 3. resume the cascade
st continue
# — or back out entirely —
st abort
```

`st abort` aborts the in-progress rebase and leaves branches after the conflict point in their pre-restack state.

## Undo a bad operation

```bash
st undo --list          # list restore points
st undo                 # roll back the last mutating command
st undo --steps 3       # roll back 3
st undo --dry-run       # preview what would change
```

Undo restores git refs and stack state. It does **not** un-push the remote — re-`st submit` if you'd already pushed.

## "Working tree is dirty"

Most commands auto-stash, so this is rare. If it blocks you:

```bash
git stash
st <command>
git stash pop
```

## Mid-stack drift (you amended a lower branch by hand)

```bash
st restack              # cascade-rebase downstream onto the updated parent
st submit               # push the rewrites
```

## Trunk moved on the remote

```bash
st sync                 # fetch, fast-forward trunk, rebase the stack onto it
st submit
```

No manual `git pull` + `st restack` needed — `sync` does both.

## Stale local stack (daemon already restacked, or another worktree pushed)

When the background daemon — or a different session/worktree — restacks and
force-pushes the stack, your local checkout is behind: `origin/*` is the truth.
Running `st sync` here used to rebase your *stale local commits* onto trunk,
duplicating or conflicting with the rebase that already happened.

```bash
st get                  # fetch, then reset local stack branches to origin/* where safe
```

`st get` adopts `origin/<branch>` whenever local is strictly behind (fast-forward)
or the remote is a clean rebase of the *same* patches (the daemon case). Branches
with real un-pushed local commits are **kept** and reported as diverged:

```bash
st get --force          # discard the local-only commits and take the remote
```

`st sync` now runs this adoption automatically as its first step, so the common
case "daemon restacked + I ran sync" just prints "Nothing to sync" with adopted
refs — no duplicate rebase. `st undo` reverts a bad adoption.

Both `st get` and `st sync` also walk the dependency chain **upward**: each
ancestor stack is adopted before the resolved one (root-down), so a dependent
stack whose parent the daemon rewrote needs nothing extra — adopting `b` pulls
in `a` automatically.

> A branch checked out with uncommitted changes (the current branch, or a second
> worktree) is skipped even under `--force` — commit or stash it, then re-run.
>
> `--force` applies only to the *resolved* stack. A diverged branch in an
> **ancestor** stack is reported with `st get -s <ancestor> --force` as the hint
> — run that explicitly to discard ancestor-local commits. An ancestor with a
> restack already in progress is skipped (warned) without aborting the run.

## After PRs merge on GitHub

```bash
st sync                 # drop merged branches, rebase the rest; cleans up the stack if all merged
st submit               # re-push / update remaining PRs
```

A **dependent** stack whose base PR merged is auto-converted to standalone by `st sync`.

## Diamond conflict phases

A diamond restack has two phases; `st continue` reports which one paused:

- **merging** — re-creating the join's merge commit from its parents. Resolve, `git add`, `st continue`.
- **replaying** — cherry-picking the join's own commits on top of the new merge. Same resolution.

`st abort` unwinds an in-progress merge or cherry-pick and resets the join branch to its pre-restack tip.

## Daemon issues

The daemon orchestrates merge cascades and caches PR status; it auto-starts. If merges stall or status looks stale:

```bash
st daemon status        # health
st daemon stop && st daemon start   # restart fresh
st daemon logs -f       # tail the log file
st daemon attach        # stream live events (optionally --stack <name>)
st daemon repo doctor   # find orphan webhooks;  add --clean to delete them
```
