# Contextual Hints for Stack Status

**Date:** 2026-03-16
**Scope:** Add non-intrusive, contextual "next action" guidance to `stack` (dashboard) and `stack status` output.

## Problem

Running `stack` shows a list of stacks with branch counts and ages. Running `stack status` shows a tree with PR statuses. Neither tells the user *what to do next*. Users — especially new ones — have to mentally map the current state to the correct next command.

## Design Principles

- **One hint, not a list.** Show only the single most relevant action.
- **Muted styling.** Use `theme.muted()` so hints fade into the background for experienced users.
- **No false urgency.** Phrased as gentle suggestions ("try `stack submit`"), not demands.
- **Fast.** Dashboard hint fetches PR statuses for the current stack only (single GraphQL call). If no current stack, skip hints entirely.

## Implementation

### Step 1: Create `src/lib/hints.ts`

New module that analyzes stack + PR state and returns a single hint string (or `null`).

```typescript
import type { PrStatus, Stack, StackPosition } from './types.js';
import { theme } from './theme.js';

/**
 * Analyze stack state and return the single most relevant hint, or null.
 * Scenarios checked in priority order (first match wins):
 */
export function getHint(
  stack: Stack,
  prStatuses: Map<number, PrStatus>,
): string | null {
  // 1. Restack in progress — already shown as a warning, don't duplicate
  if (stack.restackState) return null;

  const branches = stack.branches;
  const prs = branches.map(b => b.pr != null ? prStatuses.get(b.pr) ?? null : null);

  // 2. Any PR merged → sync
  const hasMerged = prs.some(pr => pr?.state === 'MERGED');
  if (hasMerged) {
    return `A PR was merged — run ${theme.command('stack sync')} to clean up`;
  }

  // 3. No PRs at all → submit
  const hasAnyPr = branches.some(b => b.pr != null);
  if (!hasAnyPr) {
    return `No PRs yet — run ${theme.command('stack submit')} to create them`;
  }

  // 4. Some branches missing PRs → submit
  const missingPrs = branches.filter(b => b.pr == null);
  if (missingPrs.length > 0) {
    return `${missingPrs.length} branch${missingPrs.length > 1 ? 'es' : ''} without PRs — run ${theme.command('stack submit')}`;
  }

  // 5. Checks failing
  const failing = prs.filter((pr): pr is PrStatus =>
    pr != null && (pr.checksStatus === 'FAILURE' || pr.checksStatus === 'ERROR'));
  if (failing.length > 0) {
    const nums = failing.map(pr => `#${pr.number}`).join(', ');
    return `Checks failing on ${nums} — push fixes or run ${theme.command('stack absorb')}`;
  }

  // 6. Changes requested
  const changesReq = prs.filter((pr): pr is PrStatus =>
    pr != null && pr.reviewDecision === 'CHANGES_REQUESTED');
  if (changesReq.length > 0) {
    const nums = changesReq.map(pr => `#${pr.number}`).join(', ');
    return `Changes requested on ${nums}`;
  }

  // 7. All approved + checks pass → merge
  const openPrs = prs.filter((pr): pr is PrStatus => pr?.state === 'OPEN');
  const allApproved = openPrs.length > 0 && openPrs.every(pr => pr.reviewDecision === 'APPROVED');
  const hasChecks = openPrs.some(pr => pr.checksStatus != null);
  const allChecksPass = openPrs.every(pr => pr.checksStatus === 'SUCCESS' || pr.checksStatus == null);
  if (allApproved && hasChecks && allChecksPass) {
    return `All PRs approved — run ${theme.command('stack merge --all')} to land the stack`;
  }
  if (allApproved && hasChecks) {
    return `All PRs approved — waiting for checks to pass`;
  }
  if (allApproved) {
    return `All PRs approved — run ${theme.command('stack merge --all')} to land the stack`;
  }

  // 8. All drafts → suggest marking ready
  const allDrafts = openPrs.length > 0 && openPrs.every(pr => pr.isDraft);
  if (allDrafts) {
    return `All PRs are drafts — mark ready for review when done`;
  }

  // 9. Everything in review → waiting
  const inReview = openPrs.filter(pr => pr.reviewDecision === 'REVIEW_REQUIRED');
  if (inReview.length === openPrs.length && openPrs.length > 0) {
    return `Waiting on reviewers`;
  }

  return null;
}
```

### Step 2: Integrate into `stack status` (`src/commands/status.ts`)

After **both** `ui.stackTree()` call sites in `showActiveStack()`, add the hint. The function has two branches (with position and without) — both should show hints since we have `prStatuses` in scope either way.

```typescript
import { getHint } from '../lib/hints.js';

// After each ui.stackTree() call, before the trailing newline:
const hint = getHint(stack, prStatuses);
if (hint) {
  process.stderr.write(`\n  ${theme.muted('→')} ${theme.muted(hint)}\n`);
}
```

Concretely: extract the hint logic into a shared block after the if/else that calls `stackTree`, since both branches lead to the same `process.stderr.write('\n')` at the end.

### Step 3: Integrate into dashboard (`src/lib/dashboard.ts`)

For the *current* stack only, fetch PR statuses and show a one-line hint below the stack list.

```typescript
import * as gh from './gh.js';
import { getHint } from './hints.js';

// After the stack list loop, before the footer:
if (currentStackName) {
  const currentStack = state.stacks[currentStackName];
  if (currentStack) {
    const prNumbers = currentStack.branches
      .map(b => b.pr)
      .filter((pr): pr is number => pr != null);
    if (prNumbers.length > 0) {
      const prStatuses = gh.prViewBatch(prNumbers);
      const hint = getHint(currentStack, prStatuses);
      if (hint) {
        process.stderr.write(`\n  ${theme.muted('→')} ${theme.muted(hint)}\n`);
      }
    } else {
      // No PRs — give the hint without needing to fetch
      const hint = getHint(currentStack, new Map());
      if (hint) {
        process.stderr.write(`\n  ${theme.muted('→')} ${theme.muted(hint)}\n`);
      }
    }
  }
}
```

### Step 4: No hint when not on a stack

Both dashboard and status already handle the "not on a stack" case. Hints only appear when there's a current/active stack with context to analyze.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/hints.ts` | **New** — hint analysis logic |
| `src/commands/status.ts` | Add hint after stack tree |
| `src/lib/dashboard.ts` | Add hint for current stack |

## What It Looks Like

**Dashboard (`stack`):**
```
  stack v0.4.0
  Stacked PRs for GitHub

▸ auth-refactor   3 branches   updated 2 hours ago
  frozen-column   2 branches   updated 1 day ago

  → All PRs approved — run stack merge --all to land the stack

  stack <name> to switch   stack create <name> to start
```

**Status (`stack status`):**
```
Stack: auth-refactor (on branch 2 of 3)

 ↑ main

 #  Branch                          PR    Status      Checks
 1  dug/auth/1-extract-middleware    #42   ✅ Approved  ✅ Pass
 2  dug/auth/2-add-sessions         #43   👀 Review    🔄 Running  ← you are here
 3  dug/auth/3-cleanup-legacy       #44   🔨 Draft

  → Changes requested on #43
```

## Verification

```bash
bun run src/cli.ts status          # should show hint after tree
bun run src/cli.ts                 # dashboard should show hint for current stack
bun run src/cli.ts submit --dry-run # existing behavior unchanged
```
