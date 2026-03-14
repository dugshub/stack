# Operation: Stack Status

Display the current stack as an ASCII tree with live PR status.

## Algorithm

### 1. Load stack context

```bash
CURRENT_BRANCH=$(git branch --show-current)
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
STACK_FILE="$HOME/.claude/stacks/${REPO_NAME}.json"
```

Read `$STACK_FILE`. If it does not exist, report: "No stacks found. Use `/stack create` to start one."

### 2. Find active stack

Search all stacks for a branch entry where `name` matches `$CURRENT_BRANCH`.

- If found: display that stack with position indicator
- If not found: list all stacks with summary info

### 3. Fetch live PR status

For each branch in the active stack that has a PR number, fetch:

```bash
gh pr view <PR> --json number,title,state,isDraft,url,reviewDecision
```

Map to status using the status table in `comment-template.md`.

### 4. Render ASCII tree

Format:

```
Stack: <stack-name> (on branch <position> of <total>)

<trunk>
 └─ 1. <branch-name>  #<PR> <emoji> <status>
     └─ 2. <branch-name>  #<PR> <emoji> <status>    ← you are here
         └─ 3. <branch-name>  (no PR)
```

Rules:
- Each branch is indented under its parent with `└─`
- Current branch gets `← you are here` suffix
- Branches with PRs show `#<number> <emoji> <status>`
- Branches without PRs show `(no PR)`
- Bold nothing in terminal output — this is plain text

### 5. List all stacks (when not on a stack branch)

If the current branch is not in any stack:

```
Not on a stack branch. Active stacks:

  frozen-column    3 branches  (#101, #102, +1 no PR)
  auth-refactor    2 branches  (#200, #201)

Use `/stack nav` to switch, or `/stack create` to start a new stack.
```

### 6. Edge cases

- **No stacks file**: Create it and report no stacks
- **Empty stacks object**: Report no stacks
- **Stack with restackState**: Warn "Restack in progress — resolve conflicts and run `/stack restack --continue`"
