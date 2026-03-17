# Smart Restack: Handle Rewritten Parent History

**Status:** Ready
**Date:** 2026-03-17

## Problem

When a branch in a stack has its history **rewritten** (commits split, squashed, reordered, or dropped — not just amended), `stack restack` produces cascading conflicts on every downstream branch. The user must manually resolve the same conflict at every level of the stack.

### Root Cause

The current restack uses `restackState.oldTips[parentBranch.name]` as the exclusion point for `git rebase --onto`. When the parent was rewritten before restack runs, this value is the parent's **new** tip — which has no ancestor relationship with the downstream branch's commits. Git falls back to `merge-base`, replays stale commits, and produces conflicts.

### Compounding problem: duplicated rebase logic

The same broken rebase pattern exists in **four places**:

| Location | Lines | Pattern |
|---|---|---|
| `restack.ts` `cascadeRebase` | 163-235 | `oldTips[parentBranch.name]` + worktree-aware rebase |
| `sync.ts` subsequent-branch loop | 274-309 | `oldTips[parentBranch.name]` (no worktree support) |
| `absorb.ts` cascade rebase | 291-349 | `originalTips[parentBranch.name]` + worktree-aware rebase |
| `restack.ts` first-branch rebase | 100-137 | merge-base fallback |

Each independently reimplements: fork-point lookup, worktree-aware `git rebase --onto`, tip updates on success, conflict reporting + `restackState` save on failure. Fixing the bug in one place doesn't fix the others.

## Solution

Two changes:

1. **Track `parentTip` per branch** — the parent's tip SHA at the time this branch was last rebased/created. This is the correct fork point regardless of parent rewrites.

2. **Extract rebase logic into `src/lib/rebase.ts`** — a single `rebaseBranch()` function used by all commands, plus a `cascadeRebase()` loop used by restack and sync. Fix the bug once, in one place.

### Why `parentTip` works

```
git rebase --onto <new-parent-tip> <branch.parentTip> <branch>
```

`branch.parentTip` is always an ancestor of `branch.tip` — it's where this branch forked. Git correctly identifies only this branch's own commits for replay, regardless of how the parent was rewritten.

## Implementation

### Step 1: Add `parentTip` to Branch type

**File:** `src/lib/types.ts`

```typescript
export interface Branch {
  name: string;
  tip: string | null;
  pr: number | null;
  parentTip: string | null;  // Parent's tip SHA when this branch was last rebased/created
}
```

`parentTip` is always a commit SHA, never a ref name. It must NOT be updated by `refreshTips`.

### Step 2: Make `git.rebaseOnto` worktree-aware

**File:** `src/lib/git.ts`

Add optional `cwd` parameter to `rebaseOnto`:

```typescript
export function rebaseOnto(
  newBase: string,
  oldBase: string,
  branch: string,
  opts?: { cwd?: string },
): RebaseResult {
  const args = ['rebase', '--onto', newBase, oldBase, branch];
  if (opts?.cwd) {
    const result = Bun.spawnSync(['git', ...args], {
      stdout: 'pipe', stderr: 'pipe', cwd: opts.cwd,
    });
    if (result.exitCode === 0) return { ok: true, conflicts: [] };
    const statusResult = Bun.spawnSync(['git', 'status', '--porcelain'], {
      stdout: 'pipe', stderr: 'pipe', cwd: opts.cwd,
    });
    const conflicts = statusResult.stdout.toString().split('\n')
      .filter((line) => line.startsWith('UU '))
      .map((line) => line.slice(3));
    return { ok: false, conflicts };
  }
  // existing non-worktree path unchanged
  const result = tryRun(...args);
  if (result.ok) return { ok: true, conflicts: [] };
  const statusResult = tryRun('status', '--porcelain');
  const conflicts = statusResult.stdout.split('\n')
    .filter((line) => line.startsWith('UU '))
    .map((line) => line.slice(3));
  return { ok: false, conflicts };
}
```

This eliminates ~15 lines of worktree boilerplate at each call site in restack.ts and absorb.ts.

### Step 3: Create `src/lib/rebase.ts`

New file with two exports:

#### `rebaseBranch()` — single branch rebase

Used by all commands. Handles fork-point lookup, rebase, and tip updates.

```typescript
import * as git from './git.js';
import type { Branch } from './types.js';

interface RebaseBranchOpts {
  branch: Branch;
  parentRef: string;         // parent branch name or trunk
  fallbackOldBase?: string;  // for pre-migration branches without parentTip
  worktreeMap?: Map<string, string>;
}

interface RebaseBranchResult {
  ok: boolean;
  conflicts: string[];
}

export function rebaseBranch(opts: RebaseBranchOpts): RebaseBranchResult {
  const { branch, parentRef, fallbackOldBase, worktreeMap } = opts;
  const worktreePath = worktreeMap?.get(branch.name);

  // Fork point: parentTip (correct) → fallback (legacy) → merge-base (last resort)
  const mergeBaseResult = git.tryRun('merge-base', parentRef, branch.name);
  const oldBase = branch.parentTip
    ?? fallbackOldBase
    ?? (mergeBaseResult.ok ? mergeBaseResult.stdout : null);

  if (!oldBase) {
    return { ok: false, conflicts: [] };
  }

  const result = git.rebaseOnto(parentRef, oldBase, branch.name, {
    cwd: worktreePath,
  });

  if (result.ok) {
    branch.tip = git.revParse(branch.name, { cwd: worktreePath ?? undefined });
    // parentRef is a branch/trunk name — rev-parse works from any worktree (shared refs)
    branch.parentTip = git.revParse(parentRef);
  }

  return result;
}
```

#### `cascadeRebase()` — full cascade loop

Used by restack and sync. Iterates branches, calls `rebaseBranch`, manages `restackState`.

```typescript
import { saveState } from './state.js';
import { theme } from './theme.js';
import type { Branch, RestackState, Stack } from './types.js';
import * as ui from './ui.js';

interface CascadeOpts {
  state: { stacks: Record<string, Stack>; [key: string]: unknown };
  stack: Stack;
  fromIndex: number;          // the amended branch index (-1 = all from bottom)
  startIndex: number;         // where to begin iterating (fromIndex+1 for normal, currentIndex for continue)
  worktreeMap: Map<string, string>;
  oldTips: Record<string, string>;  // legacy fallback tips (mutated as side-effect)
}

interface CascadeResult {
  ok: boolean;
  rebased: number;
  conflictBranch?: string;
  conflicts?: string[];
}

export function cascadeRebase(opts: CascadeOpts): CascadeResult {
  const { state, stack, fromIndex, startIndex, worktreeMap, oldTips } = opts;
  let rebased = 0;

  for (let i = startIndex; i < stack.branches.length; i++) {
    const branch = stack.branches[i];
    if (!branch) continue;

    const parentBranch = stack.branches[i - 1];
    const parentRef = parentBranch?.name ?? stack.trunk;

    ui.info(`Rebasing ${theme.branch(branch.name)} onto ${theme.branch(parentRef)}...`);

    const result = rebaseBranch({
      branch,
      parentRef,
      fallbackOldBase: parentBranch ? oldTips[parentBranch.name] : undefined,
      worktreeMap,
    });

    if (result.ok) {
      // Update oldTips so downstream iterations and restackState have current values
      if (branch.tip) oldTips[branch.name] = branch.tip;
      rebased++;
      saveState(state);
      ui.success(`Rebased ${theme.branch(branch.name)}`);
    } else {
      // Save restackState for --continue (fromIndex passed through from caller)
      stack.restackState = {
        fromIndex,
        currentIndex: i,
        oldTips,
      };
      saveState(state);
      ui.error(`Conflict rebasing ${theme.branch(branch.name)}`);
      if (result.conflicts.length > 0) {
        ui.info('Conflicting files:');
        for (const file of result.conflicts) {
          ui.info(`  ${file}`);
        }
      }
      ui.info(`Resolve conflicts, stage files, then run ${theme.command('stack restack --continue')}.`);
      return { ok: false, rebased, conflictBranch: branch.name, conflicts: result.conflicts };
    }
  }

  // Clear restackState on completion
  stack.restackState = null;
  stack.updated = new Date().toISOString();
  saveState(state);

  return { ok: true, rebased };
}
```

### Step 4: Rewrite restack.ts to use `rebase.ts`

**File:** `src/commands/restack.ts`

**`doRestack`:** Replace first-branch rebase block (lines 100-137) with:
```typescript
if (fromIndex === -1 && stack.branches.length > 0) {
  const firstBranch = stack.branches[0];
  if (firstBranch) {
    ui.info(`Rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}...`);
    const result = rebaseBranch({
      branch: firstBranch,
      parentRef: stack.trunk,
      fallbackOldBase: oldTips[firstBranch.name],
      worktreeMap,
    });
    if (result.ok) {
      if (firstBranch.tip) oldTips[firstBranch.name] = firstBranch.tip;
      ui.success(`Rebased ${theme.branch(firstBranch.name)}`);
    } else {
      // conflict — save restackState and exit (same as today)
    }
  }
}
```

Replace `cascadeRebase` method with call to imported `cascadeRebase`:
```typescript
return cascadeRebase({
  state, stack,
  fromIndex,
  startIndex: fromIndex === -1 ? 1 : fromIndex + 1,
  worktreeMap, oldTips,
});
```

**`doContinue`:** After `git rebase --continue` succeeds and tip is updated, set `parentTip`:
```typescript
currentBranch.tip = git.revParse(currentBranch.name, { cwd: worktreePath ?? undefined });
// Parent ref: previous branch, or trunk if first branch
const parentBranch = stack.branches[restackState.currentIndex - 1];
currentBranch.parentTip = parentBranch
  ? git.revParse(parentBranch.name)
  : git.revParse(stack.trunk);
restackState.oldTips[currentBranch.name] = currentBranch.tip;
restackState.currentIndex += 1;
saveState(state);
```

Then resume the cascade:
```typescript
return cascadeRebase({
  state, stack,
  fromIndex: restackState.fromIndex,
  startIndex: restackState.currentIndex,  // already incremented above
  worktreeMap, oldTips: restackState.oldTips,
});
```

### Step 5: Rewrite sync.ts cascade to use `rebase.ts`

**File:** `src/commands/sync.ts`

Replace the first-branch rebase (lines 224-271) with a `rebaseBranch` call:
```typescript
const result = rebaseBranch({
  branch: firstBranch,
  parentRef: stack.trunk,
  fallbackOldBase: mergedBranchTip ?? undefined,  // squash-merge legacy fallback
  worktreeMap: git.worktreeList(),
});
```

**Note on `mergedBranchTip` vs `parentTip`:** Once `parentTip` is populated on a branch, `rebaseBranch` uses it as the fork point and `mergedBranchTip` is ignored. This is correct: `parentTip` records the exact point where this branch forked from its parent, which is the right exclusion point for both squash-merge and regular-merge scenarios. `mergedBranchTip` remains as a legacy fallback for pre-migration branches that don't yet have `parentTip`.

Replace the subsequent-branch loop (lines 274-309) with:
```typescript
const cascadeResult = cascadeRebase({
  state, stack,
  fromIndex: -1,
  startIndex: 1,
  worktreeMap: git.worktreeList(),
  oldTips,
});
if (!cascadeResult.ok) return 1;
```

### Step 6: Rewrite absorb.ts rebase to use `rebaseBranch`

**File:** `src/commands/absorb.ts`

Absorb interleaves rebase + commit in the same loop, so it can't use `cascadeRebase`. Replace the inline worktree-aware rebase block (lines 301-324) with:

```typescript
const rebaseResult = rebaseBranch({
  branch,
  parentRef: parentBranch.name,
  fallbackOldBase: originalTips[parentBranch.name],  // NOTE: originalTips, not oldTips
  worktreeMap,
});
```

The `fallbackOldBase` must use `originalTips` (immutable snapshot from before the loop), not `oldTips` (mutated during the loop). `originalTips` captures pre-modification state so each branch's rebase correctly identifies its own commits.

Keep the existing conflict handling (save `restackState` from `oldTips`, exit with message) and commit logic as-is.

### Step 7: Set `parentTip` on all branch creation paths

**File:** `src/commands/push.ts`
```typescript
const parentBranch = stack.branches[stack.branches.length - 1];
const parentTip = parentBranch
  ? parentBranch.tip ?? git.revParse(parentBranch.name)
  : git.revParse(stack.trunk);
stack.branches.push({ name: currentBranch, tip, pr: null, parentTip });
```

**File:** `src/commands/create.ts`

All three paths (explicit, autoDetect, --from):
- Explicit/autoDetect: `parentTip = git.revParse(trunk)` for first branch
- `--from` retroactive adoption: compute eagerly with `merge-base`:
```typescript
const parentRef = i === 0 ? trunk : branches[i - 1];
const mb = git.tryRun('merge-base', parentRef, branch);
const parentTip = mb.ok ? mb.stdout : null;
```

**File:** `src/commands/split.ts`

```typescript
parentTip: i === 0 ? git.revParse(trunk) : git.revParse(createdBranches[i - 1])
```

### Step 8: Update remove.ts

**File:** `src/commands/remove.ts`

Leave downstream `parentTip` as-is when removing a branch (the removed branch's tip is still a valid ancestor). Only update `parentTip` if remove triggers a rebase.

### Step 9: Backfill `parentTip` for existing stacks

**File:** `src/lib/state.ts`

Add `backfillParentTips` and call it from `loadAndRefreshState`:

```typescript
function backfillParentTips(state: StackFile): boolean {
  let dirty = false;
  for (const stack of Object.values(state.stacks)) {
    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (branch && branch.parentTip == null) {
        const parentRef = i === 0 ? stack.trunk : stack.branches[i - 1]?.name;
        if (parentRef) {
          const result = git.tryRun('merge-base', parentRef, branch.name);
          if (result.ok) {
            branch.parentTip = result.stdout;
            dirty = true;
          }
        }
      }
    }
  }
  return dirty;
}

// Updated loadAndRefreshState:
export function loadAndRefreshState(): StackFile {
  const state = loadState();
  refreshTips(state);           // updates branch.tip from live refs
  if (backfillParentTips(state)) {
    saveState(state);           // persist backfill so it doesn't re-run
  }
  return state;
}
```

## What gets deleted

After extraction, the following duplicated code is removed:

| File | Removed | Replaced by |
|---|---|---|
| `restack.ts` | `cascadeRebase` method (~80 lines), worktree rebase blocks | `cascadeRebase()` from `rebase.ts` |
| `sync.ts` | First-branch rebase (~50 lines) + subsequent loop (~35 lines) | `rebaseBranch()` + `cascadeRebase()` |
| `absorb.ts` | Worktree-aware rebase block (~25 lines) | `rebaseBranch()` |

Net: ~190 lines of duplicated logic → ~60 lines in `rebase.ts`.

## Edge Cases

1. **Pre-migration branches (`parentTip === null`)**: `rebaseBranch` falls through to `fallbackOldBase` then `merge-base`. Backfill on load handles most cases.
2. **First branch in stack**: `parentRef` is trunk. `parentTip` is trunk SHA at creation. `doRestack` handles first branch separately with `rebaseBranch`, then calls `cascadeRebase(startIndex: 1)`.
3. **`doContinue` on first branch (conflict at index 0)**: `parentBranch` is undefined → use trunk for `parentTip`. Resume cascade with `startIndex: 1` (currentIndex already incremented).
4. **`remove` without rebase**: `parentTip` left as-is (still valid ancestor).
5. **`refreshTips` must NOT touch `parentTip`**: It's a historical SHA, not a live ref.
6. **Absorb interleaving**: Absorb uses `rebaseBranch()` directly with `originalTips` (immutable pre-loop snapshot) as fallback. Keeps its own loop for commit interleaving.
7. **`merge-base` failure**: `rebaseBranch` checks `.ok` before using stdout. Returns `{ ok: false }` if no fork point can be determined.

## Files Changed

| File | Change |
|---|---|
| `src/lib/types.ts` | Add `parentTip: string \| null` to `Branch` |
| `src/lib/git.ts` | Add `cwd` option to `rebaseOnto` |
| `src/lib/rebase.ts` | **New.** `rebaseBranch()` + `cascadeRebase()` |
| `src/lib/state.ts` | `backfillParentTips()` + updated `loadAndRefreshState` |
| `src/commands/restack.ts` | Replace cascade + first-branch logic with `rebase.ts` calls |
| `src/commands/sync.ts` | Replace both rebase loops with `rebase.ts` calls |
| `src/commands/absorb.ts` | Replace worktree rebase block with `rebaseBranch()` |
| `src/commands/push.ts` | Set `parentTip` when creating branch |
| `src/commands/create.ts` | Set `parentTip` in all three creation paths |
| `src/commands/split.ts` | Set `parentTip` on each created branch |
| `src/commands/remove.ts` | Leave downstream `parentTip` as-is |

## Verification

```bash
# Create a stack, rewrite branch 1's history, then restack
stack create test-smart-restack
# ... push branches 1, 2, 3
# Rewrite branch 1 (split commit, drop files, etc.)
git checkout test/1-first
git reset --soft HEAD~1
git add -A && git commit -m "rewritten"
# Restack should cascade cleanly with no conflicts
stack restack
```
