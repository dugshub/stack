#!/bin/bash
# Reset to the snapshot state for Scene 3 — fast, no rebuilding
set -e

REPO_DIR="/Users/dug/Projects/sandbox/todo"
STATE_DIR="$HOME/.claude/stacks"
DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$REPO_DIR"

# Abort any in-progress restack
st abort 2>/dev/null || true

# Reset all branches to remote
git checkout main 2>/dev/null
git fetch origin 2>/dev/null

for branch in api/1-schema api/2-models api/3-routes api/4-auth api/5-validation \
              cache/1-redis cache/2-keys cache/3-middleware \
              realtime/1-ws-server realtime/2-events realtime/3-subscriptions; do
  git checkout "$branch" 2>/dev/null || git checkout -b "$branch" "origin/$branch" 2>/dev/null
  git reset --hard "origin/$branch" 2>/dev/null
done

# Restore stack state
cp "$DEMO_DIR/scene3-state.json" "$STATE_DIR/todo.json"

# Clean working tree
git clean -fd 2>/dev/null

# Position at tip for demo
git checkout realtime/3-subscriptions

echo "✓ Reset to Scene 3 snapshot"
