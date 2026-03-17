# Merge-Order Protection for Stacked PRs

**Status:** Draft
**Date:** 2026-03-17

## Problem

When someone bypasses `stack merge` and merges a mid-stack PR manually (or via GitHub auto-merge), downstream PRs end up with duplicate commits — especially with squash merge. The existing `stack/rebase-status` check only verifies "is this branch rebased on its parent?" It does **not** enforce merge order.

### Scenario

```
Stack: PR #1 → PR #2 → PR #3  (all targeting their parent)

1. User enables auto-merge on all 3 PRs via GitHub UI
2. PR #1 merges into main (squash) ✓
3. GitHub auto-retargets PR #2 to main
4. PR #2 now shows branch 1's original commits + its own (duplicates)
5. PR #2 merges — duplicate commits land on main
```

The `stack merge` command prevents this by processing PRs sequentially through the daemon engine. But nothing prevents someone from merging out of order through GitHub directly.

### What we need

A second commit status check — `stack/merge-ready` — that blocks merging any PR that isn't the next one eligible for merge in the stack.

## Solution

Add a `stack/merge-ready` check alongside the existing `stack/rebase-status` check. The new check:

- **Passes** on the bottom-most unmerged PR in the stack (it's next to merge)
- **Fails** on all other PRs with "Waiting for PR #N to merge first"
- **Updates across the stack** whenever any PR in the stack merges or any branch is pushed

### Why a separate check

`stack/rebase-status` answers "is this branch up to date with its parent?" — a structural question about git history. `stack/merge-ready` answers "is it safe to merge this PR right now?" — a workflow question about stack ordering. Keeping them separate gives clear, specific feedback.

### Check lifecycle

| Event | Trigger | Action |
|-------|---------|--------|
| Branch pushed | Push webhook | Post merge-ready on pushed branch (live SHA), evaluate sibling branches via bare clone |
| PR merged | PR webhook | Fetch current branch HEADs from bare clone, re-evaluate remaining PRs |
| `stack submit` | Push webhook (indirect) | Same as branch pushed (each push triggers independently) |

### SHA resolution strategy

Commit statuses must be posted on the **current HEAD SHA** of each branch, not stale `branch.tip` values from disk state. The daemon does not update `branch.tip` — that's only written by the CLI during `stack submit`.

- **Push path:** Use `event.headSha` for the pushed branch. For sibling branches, resolve current HEADs from the bare clone via `git rev-parse`.
- **Merge path:** Resolve all branch HEADs from the bare clone (fetch first to get latest).

## Implementation

### Step 1: Add `stack/merge-ready` check to `rebase-check.ts`

**File:** `src/server/rebase-check.ts`

Rename to `src/server/stack-checks.ts` (it now handles both checks). Add a new constant and function:

```typescript
const MERGE_READY_CONTEXT = 'stack/merge-ready';
```

#### New function: `updateMergeReadyStatus`

```typescript
async function updateMergeReadyStatus(
  repo: string,
  state: StackFile,
  stackName: string,
  clonePath: string,
  /** SHA overrides keyed by branch name — use for the just-pushed branch */
  knownSHAs?: Map<string, string>,
): Promise<void> {
  const stack = state.stacks[stackName];
  if (!stack) return;

  // Find the first unmerged PR in the stack
  const branchesWithPRs = stack.branches.filter(b => b.pr != null);
  if (branchesWithPRs.length === 0) return;

  // Get open PR numbers for this stack
  const openPRs = await getOpenPRNumbers(repo, branchesWithPRs.map(b => b.pr!));

  // Find the first branch whose PR is still open — that's the merge-ready one
  let firstUnmergedIndex = -1;
  for (let i = 0; i < stack.branches.length; i++) {
    const branch = stack.branches[i];
    if (branch?.pr != null && openPRs.has(branch.pr)) {
      firstUnmergedIndex = i;
      break;
    }
  }

  // Post status on each open PR branch
  for (let i = 0; i < stack.branches.length; i++) {
    const branch = stack.branches[i];
    if (!branch?.pr) continue;
    if (!openPRs.has(branch.pr)) continue; // skip merged PRs

    // Resolve current HEAD — use override if available, otherwise rev-parse from bare clone
    const sha = knownSHAs?.get(branch.name)
      ?? (await gitAsync(['rev-parse', branch.name], { cwd: clonePath })).stdout?.trim();
    if (!sha) continue;

    if (i === firstUnmergedIndex) {
      await postCommitStatus(repo, sha, 'success',
        'Ready to merge (next in stack)', MERGE_READY_CONTEXT);
    } else {
      const blockingPR = stack.branches[firstUnmergedIndex]?.pr;
      await postCommitStatus(repo, sha, 'failure',
        `Waiting for PR #${blockingPR} to merge first`, MERGE_READY_CONTEXT);
    }
  }
}
```

**Key:** The function resolves live SHAs from the bare clone (or from `knownSHAs` for the just-pushed branch). It never reads `branch.tip` from disk state.

#### Helper: `getOpenPRNumbers`

```typescript
async function getOpenPRNumbers(repo: string, prNumbers: number[]): Promise<Set<number>> {
  const [owner, name] = repo.split('/');
  const result = await ghAsync(
    'api', 'graphql',
    '-f', `query=query {
      repository(owner: "${owner}", name: "${name}") {
        ${prNumbers.map((n, i) => `pr${i}: pullRequest(number: ${n}) { number state }`).join('\n')}
      }
    }`,
  );
  if (!result.ok) return new Set(prNumbers); // assume all open on failure

  const data = JSON.parse(result.stdout) as {
    data: { repository: Record<string, { number: number; state: string }> }
  };

  const open = new Set<number>();
  for (const pr of Object.values(data.data.repository)) {
    if (pr && pr.state === 'OPEN') open.add(pr.number);
  }
  return open;
}
```

### Step 2: Update `handlePushEvent` to also trigger merge-ready

**File:** `src/server/stack-checks.ts` (renamed from `rebase-check.ts`)

After the existing rebase check logic, add:

```typescript
// Also update merge-ready status for all PRs in this stack
// clonePath is already available from the rebase check above
const knownSHAs = new Map([[event.branch, event.headSha]]);
await updateMergeReadyStatus(event.repo, state, position.stackName, clonePath, knownSHAs);
```

The `clonePath` variable is already in scope from the `ensureClone` call. The `knownSHAs` map provides the live SHA for the just-pushed branch; sibling branches are resolved from the bare clone.

### Step 3: Handle PR merge events

**File:** `src/server/index.ts`

In the webhook handler, replace the early return when no job is found. Currently (around line 99-101):

```typescript
// BEFORE:
if (!job) {
  return new Response('ok');
}
```

Replace with:

```typescript
// AFTER:
if (!job) {
  if (event.type === 'pr_merged') {
    // No merge job — this was a manual/auto merge. Re-evaluate stack checks.
    await handlePRMergedEvent(event);
  }
  return new Response('ok');
}
```

This ensures the new handler runs **before** the early return, not after it.

New function in `stack-checks.ts`:

```typescript
export async function handlePRMergedEvent(
  event: Extract<WebhookEvent, { type: 'pr_merged' }>,
): Promise<void> {
  const state = loadStackStateForRepo(event.repo);
  if (!state) return;

  // Find which stack this PR belongs to
  for (const [stackName, stack] of Object.entries(state.stacks)) {
    const branch = stack.branches.find(b => b.pr === event.prNumber);
    if (branch) {
      console.log(`Merge-ready: PR #${event.prNumber} merged, updating stack "${stackName}"`);
      // Fetch bare clone to get current branch HEADs
      const repoName = event.repo.replace('/', '-');
      const repoUrl = `https://github.com/${event.repo}.git`;
      const clonePath = await ensureClone(repoUrl, repoName);
      await fetchClone(clonePath);
      await updateMergeReadyStatus(event.repo, state, stackName, clonePath);
      break;
    }
  }
}
```

### Step 4: Update `postCommitStatus` to accept context parameter

```typescript
async function postCommitStatus(
  repo: string,
  sha: string,
  state: 'success' | 'failure' | 'pending',
  description: string,
  context: string = CHECK_CONTEXT, // default to rebase-status for backwards compat
): Promise<void> {
  await ghAsync(
    'api',
    `repos/${repo}/statuses/${sha}`,
    '-f', `state=${state}`,
    '-f', `context=${context}`,
    '-f', `description=${description}`,
  );
}
```

### Step 5: Update `stack/merge-ready` filtering in `gh.ts` and `cache.ts`

The existing `!id.startsWith('stack/')` filter in `gh.ts` (lines 54-56, 109-111) and `cache.ts` (line 123) already covers `stack/merge-ready` — no changes needed.

### Step 6: Update import in `index.ts`

Update the import from `rebase-check.js` to `stack-checks.js` and add the new export.

## What this does NOT cover (intentionally)

1. **Active merge job protection** — When `stack merge` is running, the engine already enforces order. The merge-ready check is for when there's no active job.
2. **Retargeting after manual merge** — If someone manually merges PR #1, GitHub retargets PR #2 to main, but PR #2 may have stale commits. That's a separate "auto-sync on merge" feature.
3. **Branch protection rule setup** — Users must add `stack/merge-ready` as a required status check in their repo's branch protection rules. We could add a `stack protect` command later.

## Files Changed

| File | Change |
|------|--------|
| `src/server/rebase-check.ts` | Rename to `stack-checks.ts`, add `updateMergeReadyStatus`, `handlePRMergedEvent`, `getOpenPRNumbers`; update `postCommitStatus` signature |
| `src/server/index.ts` | Update import, add PR-merged handling for non-job merges |

## Edge Cases

1. **Stack with no PRs yet** — `branchesWithPRs` is empty, skip entirely.
2. **All PRs merged** — No open PRs found, skip status updates.
3. **GraphQL failure** — Fall back to assuming all PRs are open (conservative: blocks nothing).
4. **PR merged outside stack flow** — `handlePRMergedEvent` catches this and re-evaluates.
5. **Multiple stacks sharing branches** — `findBranchInStack` returns first match (existing behavior).
6. **Race: push + merge at same time** — Both paths call `updateMergeReadyStatus`, last write wins. Both are idempotent so this is safe.
7. **Active `stack merge` job running** — The `!job` guard in `index.ts` ensures `handlePRMergedEvent` only fires when there's no active merge job. When the daemon engine is managing the merge, it handles ordering itself.
8. **Bare clone staleness** — `fetchClone` is called before `rev-parse` on sibling branches. In the push path, the clone was just fetched for the rebase check. In the merge path, we explicitly fetch before resolving HEADs.

## Verification

```bash
# Create a 3-PR stack
stack create test-merge-order
# ... push 3 branches, submit
stack submit

# Check that only PR #1 has merge-ready: success
gh api repos/OWNER/REPO/commits/SHA1/statuses | jq '.[] | select(.context == "stack/merge-ready")'
gh api repos/OWNER/REPO/commits/SHA2/statuses | jq '.[] | select(.context == "stack/merge-ready")'

# Merge PR #1 manually
gh pr merge 1 --squash

# Check that PR #2 now has merge-ready: success, PR #3 still failure
```
