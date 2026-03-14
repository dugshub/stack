# PR Stack Comment Template

When updating PR comments for a stack, generate a markdown table showing all PRs with navigation.

## Template

For each PR in the stack, generate this table. The row for the PR being commented on should be **bolded**.

```markdown
## PR Stack

| | PR | Title | Status |
|---|---|---|---|
| 1 | [#101](https://github.com/owner/repo/pull/101) | feat: add schema changes | ✅ Merged |
| **2** | **[#102](https://github.com/owner/repo/pull/102)** | **feat: add API endpoint** | **👀 Review** |
| 3 | [#103](https://github.com/owner/repo/pull/103) | feat: add frontend UI | 🔨 Draft |
| 4 | | feat: add tests | ⬜ No PR |

> Managed by Claude Code [`/stack`](https://github.com/owner/repo)
```

## Status Mapping

Determine status from `gh pr view <N> --json state,isDraft,reviewDecision`:

| PR State | isDraft | reviewDecision | Emoji | Text |
|----------|---------|----------------|-------|------|
| MERGED | — | — | ✅ | Merged |
| CLOSED | — | — | ❌ | Closed |
| OPEN | true | — | 🔨 | Draft |
| OPEN | false | APPROVED | ✅ | Approved |
| OPEN | false | CHANGES_REQUESTED | 🔄 | Changes |
| OPEN | false | (empty/REVIEW_REQUIRED) | 👀 | Review |
| (no PR) | — | — | ⬜ | No PR |

## Posting the Comment

Use idempotent comment update — this creates the comment on first run and edits it on subsequent runs:

```bash
gh pr comment <PR-NUMBER> --edit-last --create-if-none --body "$(cat <<'STACKEOF'
<generated markdown table>
STACKEOF
)"
```

## Generating Titles

For branches without an existing PR title:
1. If branch name follows `<n>-<description>` convention, convert description from kebab-case to title case
2. Otherwise, use the last commit subject on the branch (relative to its parent branch)

## Construction Steps

1. Load stack JSON to get branch order and PR numbers
2. For each branch with a PR, fetch live data: `gh pr view <N> --json number,title,state,isDraft,url,reviewDecision`
3. For branches without a PR, use the branch name to derive a title
4. Build the markdown table string
5. Post to every PR in the stack using the idempotent comment command
