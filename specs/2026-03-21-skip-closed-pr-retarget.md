# Skip Closed PR Retarget During Sync

## Problem

When `st sync` converts a dependent stack to standalone (parent stack merged), it tries to retarget ALL PRs to the new base branch. This includes closed PRs, which GitHub rejects with:

> Cannot change the base branch of a closed pull request.

## Root Cause

`src/commands/sync.ts` lines 119-145: the retarget loop checks `branch.pr != null` but never checks if the PR is open. Closed or already-merged PRs should be skipped.

## Fix

### Step 1: Collect PR states during the merged-check loop

Lines 80-88 already call `gh.prView()` for each branch with a PR. Store the results in a `Map<number, PrStatus>` so we can reuse them in the retarget loop.

```typescript
// Before the merged-check loop (around line 80):
const prStatusMap = new Map<number, PrStatus | null>();

// Inside the loop, store the result:
const prStatus = gh.prView(branch.pr);
prStatusMap.set(branch.pr, prStatus ?? null);
if (prStatus?.state === 'MERGED') {
  mergedIndices.push(i);
}
```

### Step 2: Skip non-OPEN PRs in the retarget loop

In the retarget loop (line 122 area), after `if (!branch || branch.pr == null) continue;`, add:

```typescript
const status = prStatusMap.get(branch.pr);
if (!status || status.state !== 'OPEN') continue;
```

This skips closed, merged, and unknown-state PRs from retargeting.

### Step 3: Also skip non-OPEN PRs in stack comment updates

Lines 289-297 update stack comments. These should also skip closed PRs to avoid unnecessary API calls (though `gh pr comment` on closed PRs doesn't error, it's still wasteful).

No change needed here — the comment loop already handles this gracefully with a try/catch.

## Files Changed

- `src/commands/sync.ts` — only file modified

## Verification

Run `st sync` on a stack where some PRs are closed. Closed PRs should be silently skipped during retarget.
