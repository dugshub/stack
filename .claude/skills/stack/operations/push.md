# Operation: Stack Push

Add the current branch to the top of the active stack.

## Algorithm

### 1. Load context

```bash
CURRENT_BRANCH=$(git branch --show-current)
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
STACK_FILE="$HOME/.claude/stacks/${REPO_NAME}.json"
```

### 2. Find active stack

Search all stacks to determine context:

**Case A**: Current branch is already in a stack → error: "Branch '<branch>' is already in stack '<name>' at position <N>."

**Case B**: Current branch is NOT in any stack → find the stack whose top branch is an ancestor of the current branch.

To find the right stack:
```bash
# For each stack, check if the top branch is an ancestor of current
git merge-base --is-ancestor <top-branch-of-stack> <CURRENT_BRANCH>
```

If no stack's top branch is an ancestor: "No active stack found. Current branch doesn't descend from any stack's top. Use `/stack create` to start a new stack."

If multiple stacks match: "Ambiguous — current branch descends from multiple stacks. Please specify which stack with `/stack push --stack <name>`."

### 3. Validate ancestry

Verify the current branch is a direct descendant of the stack's top branch:
```bash
git merge-base --is-ancestor <top-branch> $CURRENT_BRANCH
```

If not: "Current branch '<branch>' is not descended from '<top-branch>'. It must be branched from the top of the stack."

### 4. Add to stack

```json
{
  "name": "<CURRENT_BRANCH>",
  "tip": "<git rev-parse HEAD>",
  "pr": null
}
```

Append to the stack's `branches` array. Update the stack's `updated` timestamp.

### 5. Save and report

Write JSON back to `$STACK_FILE`.

```
Added '<branch>' to stack '<name>' at position <N>.

Stack '<name>':
  1. doug/frozen-column/1-sticky-header  #101
  2. doug/frozen-column/2-scroll-shadow  #102
  3. doug/frozen-column/3-resize-handle  (no PR)  ← new

Next: make changes, commit, then `/stack submit` to push and create PRs.
```

## Edge Cases

- **On trunk branch**: "You're on '<trunk>'. Switch to a feature branch first or use `/stack create`."
- **Empty stacks file**: "No stacks exist. Use `/stack create` to start one."
- **Dirty working tree**: Not a blocker — push only modifies the JSON, not the git state.
