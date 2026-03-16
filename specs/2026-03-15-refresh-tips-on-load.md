# Refresh Branch Tips on State Load

## Problem

When commits are added to stack branches outside of `stack` commands (e.g., direct `git commit`, external tooling), the state file's `tip` fields become stale. This causes commands like `restack` to operate on outdated state, and requires manual state file edits to fix.

## Solution

Add a `refreshTips()` function to `src/lib/state.ts` that updates all branch tips to match actual git refs. Call it automatically after `loadState()` in every command that uses state.

## Design

### New function in `src/lib/state.ts`

```typescript
export function refreshTips(state: StackFile): boolean {
  let changed = false;
  for (const stack of Object.values(state.stacks)) {
    for (const branch of stack.branches) {
      const result = git.tryRun('rev-parse', branch.name);
      if (result.ok && result.stdout !== branch.tip) {
        branch.tip = result.stdout;
        changed = true;
      }
      // If rev-parse fails, branch doesn't exist locally — leave tip as-is
    }
  }
  if (changed) {
    saveState(state);
  }
  return changed;
}
```

### Integration point

Add a convenience function that combines load + refresh:

```typescript
export function loadAndRefreshState(): StackFile {
  const state = loadState();
  refreshTips(state);
  return state;
}
```

### Migration of existing commands

Replace `loadState()` with `loadAndRefreshState()` in all commands that read state and could benefit from fresh tips:

- `src/commands/status.ts`
- `src/commands/submit.ts`
- `src/commands/restack.ts`
- `src/commands/sync.ts`
- `src/commands/merge.ts`
- `src/commands/absorb.ts`
- `src/commands/nav.ts`
- `src/commands/push.ts`
- `src/commands/remove.ts`
- `src/commands/delete.ts`

**Do NOT change:** `create.ts` (creates new state, no tips to refresh), `init.ts`, `update.ts` (don't use state).

## Scope

- **1 new function** in `state.ts` (`refreshTips`)
- **1 convenience wrapper** in `state.ts` (`loadAndRefreshState`)
- **~10 import/call-site changes** across commands (mechanical: `loadState()` → `loadAndRefreshState()`)
- No new files, no new dependencies, no behavior changes beyond tip accuracy

## Edge Cases

- Branch deleted locally but still in state → `tryRun` fails, tip unchanged (correct — `sync` handles cleanup)
- Branch in worktree → `git rev-parse <branchname>` still works from main worktree (resolves the ref, not the working tree)
- No stacks in state → loop body never executes, no-op
- Tips already current → `saveState` not called (no unnecessary writes)

## Verification

```bash
# 1. Make a commit outside of stack
git commit --allow-empty -m "test"

# 2. Check that state file has stale tip
cat ~/.claude/stacks/stack.json | jq '.stacks.merge.branches[-1].tip'

# 3. Run any stack command
bun run src/cli.ts status

# 4. Verify tip is now updated
cat ~/.claude/stacks/stack.json | jq '.stacks.merge.branches[-1].tip'
```
