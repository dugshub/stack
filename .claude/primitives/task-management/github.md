# GitHub Issues — Dealbrain

Instructions for GitHub Issues integration. Repo: `findtempo/dealbrain` (private).

## Issue Structure

```
Issue
├── Title (required)
├── Body (markdown)
├── State (open, closed)
├── Labels (see below)
├── Assignees
└── Milestone (optional)
```

## Label Conventions

Use labels for categorization:
- **Type:** `bug`, `enhancement`, `chore`, `refactor`
- **Stack:** `frontend`, `backend`, `infrastructure`
- **Priority:** `priority:high`, `priority:low`

## Workflow

GitHub Issues use open/closed states. PRs reference issues with `Fixes #123` or `Closes #123` in the PR body.

## Branch Naming

```
{type}/{kebab-case-description}
```

Examples:
- `feat/keyboard-shortcuts`
- `fix/null-response-handling`
- `refactor/migrate-onboarding`
- `doug/feature-name` (personal prefix for WIP)

## CLI Reference

```bash
# Create issue
gh issue create --title "Title" --body "Description"

# List issues
gh issue list --state open

# View issue
gh issue view 123

# Create PR referencing issue
gh pr create --title "feat: add shortcuts" --body "Fixes #123"
```

## PR Conventions

- Squash merge (one commit per PR)
- PR title follows conventional commit format
- PR body includes `## Summary` and `## Test plan`
