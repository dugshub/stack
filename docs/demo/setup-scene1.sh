#!/bin/bash
# Reset todo repo to clean state for Scene 1 recording
# Run this before `vhs scene1.tape`

set -e

REPO_DIR="/Users/dug/Projects/sandbox/todo"
STATE_DIR="$HOME/.claude/stacks"

cd "$REPO_DIR"

# Close all open PRs on GitHub
for pr in $(gh pr list --repo dugshub/todo --state open --json number --jq '.[].number' 2>/dev/null); do
  gh pr close "$pr" --repo dugshub/todo --delete-branch 2>/dev/null || true
done

# Kill any local branches except main
git checkout main 2>/dev/null
git pull --ff-only 2>/dev/null || true
for branch in $(git branch --list 'dugshub/*' | tr -d ' *'); do
  git branch -D "$branch" 2>/dev/null || true
done

# Delete remote branches that might linger
for ref in $(git branch -r --list 'origin/dugshub/*' | tr -d ' '); do
  branch="${ref#origin/}"
  git push origin --delete "$branch" 2>/dev/null || true
done
git remote prune origin 2>/dev/null || true

# Nuke stack state for this repo
rm -f "$STATE_DIR/todo.json"
rm -f "$STATE_DIR/todo.history.jsonl"

# Clean working tree
git clean -fd 2>/dev/null
git checkout . 2>/dev/null

# Set git identity to suppress committer warnings
git config user.name "Doug"
git config user.email "doug@example.com"

echo "✓ Ready for Scene 1"
