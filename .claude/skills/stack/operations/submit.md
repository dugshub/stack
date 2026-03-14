# Operation: Stack Submit

Push all branches in the active stack and create/update PRs with stack navigation comments.

## Algorithm

### 1. Load context

```bash
CURRENT_BRANCH=$(git branch --show-current)
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
STACK_FILE="$HOME/.claude/stacks/${REPO_NAME}.json"
REPO_FULL=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
```

Read `$STACK_FILE`, find active stack from current branch.

### 2. Push all branches (bottom to top)

For each branch in the stack's `branches` array (index 0 first):

```bash
git push --force-with-lease origin <branch-name>
```

If push fails (e.g., branch doesn't exist on remote yet):
```bash
git push -u origin <branch-name>
```

Update the `tip` in JSON to:
```bash
git rev-parse <branch-name>
```

### 3. Create or discover PRs

For each branch, check if a PR exists:

**If PR number is in JSON and non-null**: Verify it still exists:
```bash
gh pr view <PR> --json number,state 2>/dev/null
```
If the PR was closed/deleted, treat as needing a new PR.

**If no PR**: Create one:

Determine base branch:
- Index 0 → base is `trunk` (e.g., `main`)
- Index N → base is `branches[N-1].name`

Determine title:
- If branch name matches `*/<n>-<description>` pattern: convert `<description>` from kebab-case to title case
- Otherwise: use the first commit subject unique to this branch:
  ```bash
  git log --oneline <base>..<branch> | tail -1 | cut -d' ' -f2-
  ```

Determine draft status:
- Index 0 (bottom of stack): NOT draft
- All others: draft by default

Create the PR:
```bash
gh pr create \
  --base <base-branch> \
  --head <branch-name> \
  --title "<title>" \
  --body "Part of a PR stack. Full stack details will be posted as a comment." \
  --draft  # (omit for index 0)
```

Parse the PR number from the output URL and store in JSON.

**Ask user to confirm titles** for any newly created PRs before creating them. Show the proposed titles and let them edit.

### 4. Update stack comments on ALL PRs

**IMPORTANT: Re-read `$CLAUDE_SKILL_DIR/../comment-template.md` NOW before generating any comment body.** Do not generate comments from memory or prior context — the template is the single source of truth for format and style. Every comment must match the template exactly.

For each branch with a PR, fetch live status:
```bash
gh pr view <PR> --json number,title,state,isDraft,url,reviewDecision
```

Build the stack table markdown. For each PR, the row representing THAT PR should be bolded.

Post the comment:
```bash
gh pr comment <PR> --edit-last --create-if-none --body "$(cat <<'STACKEOF'
## PR Stack

| | PR | Title | Status |
|---|---|---|---|
| 1 | [#101](url) | feat: add schema | 👀 Review |
| **2** | **[#102](url)** | **feat: add API** | **🔨 Draft** |
| 3 | [#103](url) | feat: add UI | 🔨 Draft |

> Managed by Claude Code [`/stack`](https://github.com/owner/repo)
STACKEOF
)"
```

### 5. Save JSON and report

Update all `tip` values and `pr` numbers. Set stack `updated` timestamp.

Report:
```
Stack '<name>' submitted:

  Branch                              PR      Status
  ──────                              ──      ──────
  doug/frozen-column/1-sticky-header  #101    pushed (existing PR)
  doug/frozen-column/2-scroll-shadow  #102    pushed (existing PR)
  doug/frozen-column/3-resize-handle  #103    created (new PR, draft)

Stack comments updated on all 3 PRs.
```

## Error Handling

- **Push rejected (not force-with-lease safe)**: "Push rejected for '<branch>'. Someone else may have pushed. Run `git fetch` and check."
- **PR creation fails**: Report the error, continue with remaining branches, summarize failures at end.
- **Rate limiting**: If `gh` commands fail with rate limit errors, report and suggest waiting.
- **No stack found**: "Not on a stack branch. Use `/stack create` first."
