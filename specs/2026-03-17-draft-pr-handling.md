# Draft PR Handling + Merge Job Recovery

**Status:** Draft
**Date:** 2026-03-17

## Problems

### 1. Draft PRs crash `stack merge`

`stack merge --all` fails with a cryptic GraphQL error ("Pull request is a draft") when any PR is a draft. GitHub rejects `enablePullRequestAutoMerge` on draft PRs. Users must manually `gh pr ready` each one.

### 2. No way to recover from stuck merge jobs

When a merge job fails mid-flight (push rejected, daemon restarted, CI stuck), the job stays in "running" state forever. `stack sync`, `stack merge`, and other commands refuse to run because they see an active job. The only recovery is manually editing `merge-jobs.json`.

## Solution

### Draft handling

1. **`stack merge`**: Check for drafts before creating the job. Offer to mark them ready (interactive) or fail with clear instructions (non-interactive).
2. **`stack submit --ready`**: New flag to mark all PRs as ready-for-review. Suggest it when drafts exist.

### Merge job recovery

3. **`stack merge --abort`**: Cancel a stuck merge job. Marks it as failed and clears the block.
4. **Stale job detection**: Jobs running for >30 minutes with no updates are flagged as stale. `stack merge --status` shows a hint to abort.

## Implementation

### Step 1: Add `prReady` to `gh.ts`

**File:** `src/lib/gh.ts`

```typescript
export function prReady(prNumber: number): void {
  run('pr', 'ready', String(prNumber));
}
```

### Step 2: Draft check in `merge.ts`

**File:** `src/commands/merge.ts`

In `startMerge`, after filtering `unmergedBranches` (line ~194) and before the auto-merge check (line ~202), add:

```typescript
// Check for draft PRs
const draftBranches = unmergedBranches.filter((b) => {
  const status = prStatuses.get(b.pr as number);
  return status?.isDraft;
});

if (draftBranches.length > 0) {
  const draftList = draftBranches.map((b) => `#${b.pr}`).join(', ');
  ui.warning(`Draft PRs found: ${draftList}`);

  if (process.stderr.isTTY) {
    const ready = await p.confirm({
      message: `Mark ${draftBranches.length} draft PR${draftBranches.length > 1 ? 's' : ''} as ready for review?`,
    });
    if (p.isCancel(ready) || !ready) {
      ui.info('Merge cancelled. Mark PRs as ready first:');
      for (const b of draftBranches) {
        ui.info(`  gh pr ready ${b.pr}`);
      }
      return 2;
    }
    for (const b of draftBranches) {
      gh.prReady(b.pr as number);
      ui.success(`Marked #${b.pr} as ready for review`);
    }
  } else {
    ui.error('Cannot merge draft PRs. Mark them as ready first:');
    for (const b of draftBranches) {
      ui.info(`  gh pr ready ${b.pr}`);
    }
    return 2;
  }
}
```

### Step 3: Add `--abort` flag to `merge.ts`

**File:** `src/commands/merge.ts`

Add option:

```typescript
abort = Option.Boolean('--abort', false, {
  description: 'Cancel an active merge job',
});
```

In `execute()`, handle early (before `resolveStack`):

```typescript
if (this.abort) {
  return this.abortMerge();
}
```

No — we need the stack name to find the job. Handle after `resolveStack`:

```typescript
// In execute(), after resolveStack:
if (this.abort) {
  return this.abortMerge(resolvedName);
}
```

New method:

```typescript
private abortMerge(stackName: string): number {
  const job = findActiveJobForStack(stackName);
  if (!job) {
    ui.info('No active merge job for this stack.');
    return 0;
  }

  job.status = 'failed';
  const currentStep = job.steps[job.currentStep];
  if (currentStep && currentStep.status !== 'done' && currentStep.status !== 'merged') {
    currentStep.status = 'failed';
    currentStep.error = 'Aborted by user';
  }
  job.updated = new Date().toISOString();
  saveJob(job);

  ui.success(`Merge job ${job.id} aborted.`);
  return 0;
}
```

Import `saveJob` from `../server/state.js` (already imported: `findActiveJobForStack`).

### Step 4: Stale job hint in `showStatus`

**File:** `src/commands/merge.ts`

In `showStatus()`, after displaying the job (around line 152), check if the job is stale:

```typescript
const ageMs = Date.now() - new Date(activeJob.updated).getTime();
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
if (activeJob.status === 'running' && ageMs > STALE_THRESHOLD_MS) {
  process.stderr.write('\n');
  ui.warning(`This job hasn't been updated in ${Math.round(ageMs / 60000)} minutes.`);
  ui.info(`If it's stuck, run ${theme.command('stack merge --abort')} to cancel it.`);
}
```

### Step 5: Stale job hint in `startMerge` existing-job check

**File:** `src/commands/merge.ts`

In `startMerge`, the existing-job check (line 162-168) currently just errors. Enhance it:

```typescript
const existing = findActiveJobForStack(stackName);
if (existing) {
  const ageMs = Date.now() - new Date(existing.updated).getTime();
  const STALE_THRESHOLD_MS = 30 * 60 * 1000;

  if (ageMs > STALE_THRESHOLD_MS) {
    ui.warning(`A merge job exists but hasn't been updated in ${Math.round(ageMs / 60000)} minutes.`);
    if (process.stderr.isTTY) {
      const abort = await p.confirm({
        message: 'Abort the stale job and start a new merge?',
      });
      if (p.isCancel(abort) || !abort) {
        ui.info(`Use ${theme.command('stack merge --status')} to check progress.`);
        return 2;
      }
      existing.status = 'failed';
      const currentStep = existing.steps[existing.currentStep];
      if (currentStep && currentStep.status !== 'done' && currentStep.status !== 'merged') {
        currentStep.status = 'failed';
        currentStep.error = 'Aborted — stale job';
      }
      existing.updated = new Date().toISOString();
      saveJob(existing);
      ui.success('Stale job aborted.');
    } else {
      ui.error(`A stale merge job exists. Run ${theme.command('stack merge --abort')} to cancel it.`);
      return 2;
    }
  } else {
    ui.error(
      `A merge job is already active for this stack. Use ${theme.command('stack merge --status')} to check progress.`,
    );
    return 2;
  }
}
```

### Step 6: Add `--ready` flag to `submit.ts`

**File:** `src/commands/submit.ts`

Add option:

```typescript
ready = Option.Boolean("--ready", false, {
  description: "Mark all PRs as ready for review (not draft)",
});
```

In `fullSubmit`, after the submit summary, add:

```typescript
// Mark PRs as ready if --ready flag is set
if (this.ready) {
  for (const branch of stack.branches) {
    if (branch.pr != null) {
      const details = prDetailsMap.get(branch.pr);
      // Only call ready on PRs that are drafts (new PRs are always drafts)
      if (!details || details.isDraft) {
        try {
          gh.prReady(branch.pr);
          ui.success(`Marked #${branch.pr} as ready for review`);
        } catch {
          ui.warning(`Could not mark #${branch.pr} as ready`);
        }
      }
    }
  }
}
```

Note: `prDetailsMap` is the `BatchReadResult.prs` map from Phase 2. Check that it contains `isDraft`. If it doesn't (it uses `fetchPRDetails` from `graphql.ts`), we need to check `graphql.ts`.

### Step 7: Suggest `--ready` in submit

**File:** `src/commands/submit.ts`

After the submit summary, if `--ready` wasn't passed:

```typescript
if (!this.ready) {
  // Check if any PRs are drafts (newly created PRs are always drafts)
  const newPRCount = stack.branches.filter((b) => {
    // Branches that had no PR before this submit are new drafts
    return b.pr != null && !prDetailsMap.has(b.pr);
  }).length;
  const existingDraftCount = stack.branches.filter((b) => {
    if (b.pr == null) return false;
    const details = prDetailsMap.get(b.pr);
    return details?.isDraft;
  }).length;

  if (newPRCount > 0 || existingDraftCount > 0) {
    ui.info(`\nTip: Use ${theme.command('stack submit --ready')} to mark draft PRs as ready for review.`);
  }
}
```

**Correction:** Newly created PRs won't be in `prDetailsMap` (it was fetched before creation). But they ARE in `stack.branches` with a `pr` number now (assigned during Phase 3). We can track which branches were newly created by checking which ones had `pr == null` before Phase 3 ran. Simpler: just check if any PR is a draft by re-querying, OR track new PRs by saving the list before Phase 3.

Simplest approach: track new PR numbers in a `Set<number>` during Phase 3, then in the suggestion check, any PR in that set is a new draft:

```typescript
// In Phase 3, after creating PRs:
const newPRNumbers = new Set<number>();
// ... existing creation logic ...
// After assigning branch.pr = createdPR.number:
newPRNumbers.add(createdPR.number);
```

Then in the suggestion:
```typescript
if (!this.ready) {
  const hasDrafts = newPRNumbers.size > 0 || stack.branches.some((b) => {
    if (b.pr == null) return false;
    const details = prDetailsMap.get(b.pr);
    return details?.isDraft;
  });
  if (hasDrafts) {
    ui.info(`\nTip: Use ${theme.command('stack submit --ready')} to mark draft PRs as ready for review.`);
  }
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/lib/gh.ts` | Add `prReady()` |
| `src/commands/merge.ts` | Draft check, `--abort` flag, stale job detection + auto-abort, `saveJob` import |
| `src/commands/submit.ts` | `--ready` flag, mark PRs ready, suggest when drafts exist |

## Edge Cases

1. **No drafts** — Draft check passes silently, no change to merge flow.
2. **Non-interactive merge with drafts** — Fails with explicit `gh pr ready` instructions.
3. **`--abort` with no active job** — Reports "no active merge job", exits 0.
4. **Stale job + new merge attempt (interactive)** — Offers to abort stale job and start fresh.
5. **Stale job + new merge attempt (non-interactive)** — Fails with `--abort` hint.
6. **`gh pr ready` fails** — In merge, error propagates (blocks merge). In submit, caught and warned.
7. **All PRs already ready** — `--ready` flag is a no-op (skips non-draft PRs).
8. **Newly created PRs** — Always drafts. `--ready` marks them ready. Suggestion shown if `--ready` not passed.
