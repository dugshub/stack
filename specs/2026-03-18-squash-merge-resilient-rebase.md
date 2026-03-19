# Spec: Squash-Merge Resilient Rebase

**Problem:** After a PR is squash-merged on GitHub, rebasing downstream branches causes spurious conflicts. The squash commit on `main` may produce a different tree than the merged branch's tip (because `main` advanced), so downstream commits' context lines don't match, causing conflicts even when the changes don't logically conflict.

**Root cause:** The `git rebase --onto main <old-tip> branch` command replays commits whose diff context was computed against the old branch tip. If `main`'s tree at the squash commit differs from that tip (due to intervening commits on `main`), git reports conflicts in the context lines.

**Why the stored-tip fix from 2026-03-13 isn't enough:** That fix ensured we use the correct `oldBase` (the merged branch's tip, not `merge-base`). This correctly limits which commits are replayed. But the conflicts aren't from replaying wrong commits — they're from context-line mismatches between the squash commit's tree and the old branch tip's tree.

## Changes

### 1. Add `--empty=drop` to all rebase commands

**Files:** `src/lib/git.ts`, `src/server/clone.ts`

When commits are replayed after squash-merge and git CAN auto-resolve them, the result may be an empty commit (changes already present via squash). Note: `--empty=drop` is already the default for non-interactive rebase in modern git, but adding it explicitly makes the intent clear and guards against `rebase.emptyBehavior` config overrides.

**`src/lib/git.ts:rebaseOnto()`** — Change line 99:
```typescript
// Before:
const args = ['rebase', '--onto', newBase, oldBase, branch];
// After:
const args = ['rebase', '--onto', newBase, '--empty=drop', oldBase, branch];
```

**`src/server/clone.ts:rebaseInWorktree()`** — Change line 73:
```typescript
// Before:
['git', 'rebase', '--onto', opts.onto, opts.oldBase, opts.branch],
// After:
['git', 'rebase', '--onto', opts.onto, '--empty=drop', opts.oldBase, opts.branch],
```

### 2. Pre-restack before `stack merge`

**File:** `src/commands/merge.ts`

This is the most impactful fix. Before creating the merge job, ensure all branches are rebased onto current trunk. When branches are up-to-date with `main`, the squash commit's tree will match the branch tip exactly, and downstream rebases will apply cleanly.

**In `startMerge()`, after validation but before building the merge job.**

Guards required (matching sync.ts/restack.ts patterns):
- `git.isDirty()` check before touching git state (matches `sync.ts:66-71`)
- `stack.restackState` check to avoid corrupting in-progress restack (matches `sync.ts:58-63`)
- Use `git.checkout()` not `git.run('checkout', ...)` for consistency
- Log a warning (not error) if trunk fast-forward fails (matches `sync.ts:226-231`)

```typescript
// Guards
if (git.isDirty()) {
  ui.error('Working tree is dirty. Commit or stash changes before merging.');
  return 2;
}
if (stack.restackState) {
  ui.error('A restack is in progress. Finish it first with `stack continue` or `stack abort`.');
  return 2;
}

// Fetch + fast-forward trunk
git.fetch();
const currentBranch = git.currentBranch();
git.checkout(stack.trunk);
const ffResult = git.tryRun('merge', '--ff-only', `origin/${stack.trunk}`);
if (!ffResult.ok) {
  ui.warn(`Could not fast-forward ${stack.trunk} — using local trunk state.`);
}

// Check if first branch needs rebasing
const firstBranch = stack.branches[0];
if (firstBranch) {
  const mergeBase = git.tryRun('merge-base', stack.trunk, firstBranch.name);
  const trunkTip = git.revParse(stack.trunk);
  if (mergeBase.ok && mergeBase.stdout !== trunkTip) {
    ui.info('Restacking branches onto current trunk before merge...');
    // Restack all branches (same logic as restack command)
    const worktreeMap = git.worktreeList();
    const oldTips: Record<string, string> = {};
    for (const branch of stack.branches) {
      oldTips[branch.name] = branch.tip ?? git.revParse(branch.name);
    }

    // Rebase first onto trunk
    const firstResult = rebaseBranch({
      branch: firstBranch,
      parentRef: stack.trunk,
      fallbackOldBase: oldTips[firstBranch.name],
      worktreeMap,
    });
    if (!firstResult.ok) {
      // Abort the failed rebase so we leave a clean state
      git.tryRun('rebase', '--abort');
      git.checkout(currentBranch);
      ui.error('Pre-merge restack failed. Resolve conflicts with `stack restack` first.');
      return 2;
    }
    if (firstBranch.tip) oldTips[firstBranch.name] = firstBranch.tip;

    // Cascade remaining branches
    if (stack.branches.length > 1) {
      const cascadeResult = cascadeRebase({
        state, stack, fromIndex: -1, startIndex: 1,
        worktreeMap, oldTips,
      });
      if (!cascadeResult.ok) {
        git.checkout(currentBranch);
        ui.error('Pre-merge restack failed. Resolve conflicts with `stack restack` first.');
        return 2;
      }
    }

    // Push all restacked branches
    const pushPlans = stack.branches
      .filter(b => git.needsPush(b.name))
      .map(b => ({ branch: b.name, mode: 'force-with-lease' as const }));
    if (pushPlans.length > 0) {
      ui.info(`Pushing ${pushPlans.length} restacked branches...`);
      const pushResults = await git.pushParallel('origin', pushPlans);
      const failed = pushResults.filter(r => !r.ok);
      if (failed.length > 0) {
        git.checkout(currentBranch);
        ui.error(`Push failed: ${failed.map(r => r.error).join(', ')}`);
        return 2;
      }
    }
    saveState(state);
    ui.success('Pre-merge restack complete.');
  }
}

git.checkout(currentBranch);
```

**Imports to add at the top of `merge.ts`:**
```typescript
import { cascadeRebase, rebaseBranch } from '../lib/rebase.js';
```

**Placement:** Insert the pre-restack block after the draft-PR handling block (line ~319) and before the auto-merge availability check (line ~322). The dirty-tree and restackState guards can go at the very start of `startMerge()` before the dependent-stack guard.

### 3. Daemon rebase fallback with `--empty=drop` (already covered by change 1)

The daemon's rebase in `clone.ts` gets `--empty=drop` from change 1. No additional daemon changes needed.

If the daemon rebase still fails (genuine conflict), the error message is already propagated via SSE. No change needed — the pre-merge restack (change 2) makes daemon conflicts rare.

## What This Does NOT Do

- **No `git rerere`** — it would help for recurring conflicts but adds global git config side effects. Can be a follow-up.
- **No tree-transplant fallback** — applying diffs instead of replaying commits would avoid context-line conflicts but loses commit history. Too complex for the payoff.
- **No `-X ours/theirs` auto-resolution** — risky; could silently discard genuine conflicts.

## Verification

1. Create a 3-branch stack on a repo with active `main` development
2. Let `main` advance (merge unrelated PRs)
3. Run `stack merge --all` — observe that it restacks before merging
4. After first PR squash-merges, daemon rebase of branch-2 should succeed (trees match)
5. `stack merge --dry-run` should show the restack step

Also test:
- `stack sync` after manual squash-merge on GitHub (should work with `--empty=drop`)
- `stack restack` on a stack behind `main` (unchanged behavior, just with `--empty=drop`)
- Pre-merge restack conflict → user gets clear error to resolve first

## Files Changed

| File | Change |
|------|--------|
| `src/lib/git.ts` | Add `--empty=drop` to `rebaseOnto()` |
| `src/server/clone.ts` | Add `--empty=drop` to worktree rebase |
| `src/commands/merge.ts` | Pre-restack + push before creating merge job |
