# Operation: Stack Create

Initialize a new PR stack. Supports three modes: explicit create, auto-detect, and retroactive add.

## Prerequisites

```bash
CURRENT_BRANCH=$(git branch --show-current)
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
STACK_FILE="$HOME/.claude/stacks/${REPO_NAME}.json"
REPO_OWNER=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
GH_USER=$(gh api user --jq '.login')
```

If `$STACK_FILE` does not exist, create it:
```json
{"repo": "<REPO_OWNER>", "stacks": {}}
```

## Mode Detection

Parse `$ARGUMENTS` after `create`:
- If `--from <branch1> <branch2> ...` is present → **Mode 3: Retroactive**
- If a name is provided → **Mode 1: Explicit**
- If no arguments → **Mode 2: Auto-detect**

---

## Mode 1: Explicit Create

**Input:** `/stack create <stack-name>` optionally followed by a description for the first branch.

### Steps

1. **Validate stack name**: Must be kebab-case, no slashes. Error if a stack with this name already exists.

2. **Check current branch**:
   - If on `main` (or trunk): proceed normally
   - If on another branch: ask "You're on `<branch>`. Create stack starting from here, or switch to main first?"

3. **Determine branch name**:
   - Ask user for a description of the first branch's change (or accept from args)
   - Branch name: `<GH_USER>/<stack-name>/1-<description>`

4. **Create the branch**:
   ```bash
   git checkout -b <branch-name>
   ```

5. **Record in JSON**:
   ```json
   {
     "trunk": "main",
     "branches": [
       {
         "name": "<branch-name>",
         "tip": "<git rev-parse HEAD>",
         "pr": null
       }
     ],
     "created": "<ISO-8601-now>",
     "updated": "<ISO-8601-now>"
   }
   ```

6. **Report**:
   ```
   Stack 'frozen-column' created.
   On branch: doug/frozen-column/1-sticky-header (1 of 1)

   Next: make your changes, commit, then `/stack submit` to create PRs.
   To add more branches: commit, then run `/stack push` after creating the next branch.
   ```

---

## Mode 2: Auto-detect

When user runs `/stack create` with no arguments while on a non-trunk branch.

### Steps

1. **Check if current branch is in a stack**: If yes, report "Already in stack '<name>'" and show status.

2. **Check parent**: Find what branch the current branch was created from:
   ```bash
   git log --oneline --decorate main..<CURRENT_BRANCH> | tail -1
   ```

3. **If parent is in a stack**: Offer to add current branch to that stack.

4. **If parent is not in a stack**: Offer to create a new stack with a suggested name derived from the branch name.

5. **Ask user to confirm** stack name and proceed with creation.

---

## Mode 3: Retroactive Add

**Input:** `/stack create <stack-name> --from <branch1> <branch2> <branch3> ...`

### Steps

1. **Validate all branches exist**:
   ```bash
   git rev-parse --verify <branch> 2>/dev/null
   ```
   Error if any branch does not exist.

2. **Verify parent-child chain**: Each branch should be an ancestor of the next:
   ```bash
   git merge-base --is-ancestor <branch-N> <branch-N+1>
   ```
   Warn (but don't block) if the chain is broken — the user may know what they're doing.

3. **Discover existing PRs** for each branch:
   ```bash
   gh pr list --head <branch> --json number --jq '.[0].number // empty'
   ```

4. **Record all branches**:
   ```json
   {
     "trunk": "main",
     "branches": [
       {"name": "<branch1>", "tip": "<rev-parse>", "pr": <number|null>},
       {"name": "<branch2>", "tip": "<rev-parse>", "pr": <number|null>},
       {"name": "<branch3>", "tip": "<rev-parse>", "pr": <number|null>}
     ],
     "created": "<now>",
     "updated": "<now>"
   }
   ```

5. **Report**:
   ```
   Stack 'frozen-column' created from 3 existing branches:
     1. doug/frozen-column/1-sticky-header  #101
     2. doug/frozen-column/2-scroll-shadow  #102
     3. doug/frozen-column/3-resize-handle  (no PR)
   ```

---

## Repo Settings Check (first-time per repo)

When creating the first stack for a repo (i.e., the stacks file is new or empty), check the repo's merge settings:

```bash
gh api repos/{owner}/{repo} --jq '.delete_branch_on_merge'
```

If `false`, warn:
```
Note: This repo does not auto-delete merged PR branches. When a stacked PR merges
and the branch is deleted manually, GitHub may auto-close downstream PRs.

The /stack sync operation handles this defensively (retargets before deleting), but
enabling auto-delete is recommended as an extra safety net:

  gh api repos/<owner>/<repo> --method PATCH --field delete_branch_on_merge=true

(Requires admin permissions on the repo.)
```

This check runs once — when the stacks file is first created. Not on every `/stack create`.

## Error Handling

- **Stack name already exists**: "Stack '<name>' already exists. Use a different name or `/stack` to see it."
- **Branch already in another stack**: "Branch '<branch>' is already in stack '<other-stack>'. A branch can only belong to one stack."
- **Not a git repo**: "Not in a git repository."
- **gh not authenticated**: "GitHub CLI not authenticated. Run `gh auth login` first."
