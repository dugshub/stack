# Operation: Stack Nav

Navigate up or down the PR stack by checking out parent or child branches.

## Usage

```
/stack nav up      # move toward trunk (parent branch)
/stack nav down    # move away from trunk (child branch)
/stack nav top     # jump to the top of the stack (furthest from trunk)
/stack nav bottom  # jump to the bottom of the stack (closest to trunk)
```

## Algorithm

### 1. Load context

```bash
CURRENT_BRANCH=$(git branch --show-current)
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
STACK_FILE="$HOME/.claude/stacks/${REPO_NAME}.json"
```

Read `$STACK_FILE`, find active stack and current branch index.

### 2. Determine target

| Direction | Target Index | Error Condition |
|-----------|-------------|-----------------|
| `up` | `currentIndex - 1` | At index 0 (already at bottom). Offer: "Already at bottom. Go to trunk (`main`)?" |
| `down` | `currentIndex + 1` | At last index (already at top): "Already at top of stack." |
| `top` | last index | — |
| `bottom` | 0 | — |

Special case for `up` when at index 0: offer to checkout trunk branch. This exits the stack but is often what the user wants.

### 3. Checkout target branch

```bash
git checkout <target-branch-name>
```

If checkout fails (dirty working tree):
```
Cannot switch branches — you have uncommitted changes.
Commit or stash your changes first, then try again.
```

### 4. Report

```
Now on: doug/frozen-column/2-scroll-shadow (2 of 3)
  ↑ doug/frozen-column/1-sticky-header  #101
  ↓ doug/frozen-column/3-resize-handle  #103
```

Show the immediate parent (↑) and child (↓) for orientation. Omit if at boundary.

## Edge Cases

- **Not on a stack branch**: "Not on a stack branch. Stacks available: ..." List stacks and their bottom branches. Offer to jump to a stack's bottom or top.
- **No argument**: "Usage: `/stack nav up|down|top|bottom`"
- **Branch in worktree**: If trying to checkout a branch that's checked out in another worktree, git will refuse. Report: "Branch '<branch>' is checked out in worktree at '<path>'. Navigate to that worktree instead."
