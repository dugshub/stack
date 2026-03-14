# Operation: Stack Restack

Cascade rebase from the current (modified) branch through all downstream branches in the stack.

## When to Use

After editing a branch in the middle of a stack (adding commits, amending, rebasing onto updated trunk), all downstream branches are based on the old version. Restack updates them sequentially.

## Algorithm

### 1. Load context

```bash
CURRENT_BRANCH=$(git branch --show-current)
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
STACK_FILE="$HOME/.claude/stacks/${REPO_NAME}.json"
```

Read `$STACK_FILE`, find active stack and current branch position (index).

### 2. Check for --continue

If `$ARGUMENTS` contains `--continue`:
1. Read `restackState` from the active stack
2. If null: "No restack in progress."
3. Verify no conflicts remain: `git status --porcelain` should show no UU entries
4. Complete the current rebase: `git rebase --continue`
5. If rebase succeeds: update tip for current branch, advance to next branch, go to step 4
6. If rebase fails again: report new conflict and stop

### 3. Check for dirty working tree

Before any rebase operations, check for uncommitted changes:

```bash
if [ -n "$(git status --porcelain)" ]; then
  # Dirty working tree — fail early with clear message
fi
```

If dirty, report:
```
Cannot restack — you have uncommitted changes.

Options:
  1. Commit your changes: git add . && git commit -m "wip"
  2. Stash your changes: git stash push -m "before restack"
  3. Discard your changes: git checkout .

Then run /stack restack again.
```

Stop execution. Do NOT auto-stash — the user should decide what to do with their changes.

### 4. Determine restack range

The current branch has been modified. All branches AFTER it in the array need restacking.

```
fromIndex = current branch's index in the array
restackRange = branches[fromIndex + 1] through branches[last]
```

If `fromIndex` is the last branch: "Nothing to restack — you're on the top of the stack."

### 5. Snapshot old tips

Before modifying anything, save the current tips of all branches that will be restacked:

```json
"restackState": {
  "fromIndex": <fromIndex>,
  "currentIndex": <fromIndex + 1>,
  "oldTips": {
    "<branch-at-fromIndex>": "<current-tip>",
    "<branch-at-fromIndex+1>": "<current-tip>",
    ...
  }
}
```

Update the current branch's tip in JSON to its actual current value:
```bash
git rev-parse <CURRENT_BRANCH>
```

Save JSON with restackState.

### 6. Build worktree map

```bash
git worktree list --porcelain
```

Parse output to build a map: `branch-name → worktree-path`. Format:
```
worktree /path/to/worktree
HEAD abc1234
branch refs/heads/branch-name
```

### 7. Cascade rebase

For each branch in restack range (in order, from `fromIndex + 1` to end):

**Determine parent branch:**
- If index is `fromIndex + 1`: parent is `branches[fromIndex].name` (the modified branch)
- Otherwise: parent is `branches[index - 1].name` (the previously restacked branch)

**Determine old parent tip:**
- From `restackState.oldTips[<parent-branch>]`
- This is the commit the child was originally based on

**Determine execution directory:**
- Check worktree map for the current branch being restacked
- If in a worktree: execute from that worktree's path
- If not in a worktree: execute from the main worktree (cwd)

**Run rebase:**
```bash
# If branch is in a worktree at /path/to/wt:
cd /path/to/wt && git rebase --onto <parent-branch> <old-parent-tip> <branch-name>

# If branch is NOT in a worktree:
git rebase --onto <parent-branch> <old-parent-tip> <branch-name>
```

**On success:**
- Update `restackState.currentIndex` to next
- Update the branch's `tip` in JSON: `git rev-parse <branch-name>`
- Save JSON (so progress is durable)
- Continue to next branch

**On conflict:**
- Save `restackState` with current position
- Save JSON
- Report:
  ```
  Conflict while restacking '<branch-name>'.

  Conflicting files:
    - path/to/conflicted/file.ts

  To resolve:
    1. Fix the conflicts in the files above
    2. Stage resolved files: git add <files>
    3. Run: /stack restack --continue

  To abort the entire restack:
    git rebase --abort
    Then manually clean up restackState from ~/.claude/stacks/<repo>.json
  ```
- Stop execution

### 8. Complete

After all branches are restacked:

1. Clear `restackState` (set to null)
2. Update all branch tips in JSON
3. Save JSON

Report:
```
Restacked <N> branches in stack '<name>':

  ✓ doug/frozen-column/2-scroll-shadow  (rebased onto 1-sticky-header)
  ✓ doug/frozen-column/3-resize-handle  (rebased onto 2-scroll-shadow)

Local only — run `/stack submit` to push and update PRs.
```

## Important Notes

- **Restack is LOCAL ONLY** — it does NOT push. User must run `/stack submit` after to push.
- **Force-with-lease** will be used by submit to safely update remote branches.
- **Worktree agents**: If an agent in a worktree needs to restack, it can rebase its own branch. The cascade for other worktree branches requires the orchestrator to cd into each worktree.
- **Dirty working tree**: Rebase will fail if there are uncommitted changes. Report this clearly and ask user to commit or stash first.
