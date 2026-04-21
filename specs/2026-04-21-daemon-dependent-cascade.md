# Daemon: cascade to dependent stacks on PR merge

Status: draft
Date: 2026-04-21

## Problem

When a PR merges via GitHub webhook, the daemon's `handlePRMerged`
(`src/server/index.ts:47`) cascades only within the merged PR's own stack:

- If there are remaining branches above the merged one, it rebases the next
  one onto trunk, pushes, updates `rebase-status`, and retargets the PR.
- If it was the last branch (fully merged), it logs `Stack "X" fully merged`
  and returns.

If another stack **depends on** the merged branch (`dependsOn: [{ stack:
X, branch: merged-branch }]`), that dependent stack is left stale:
- Its `trunk` still points at the now-merged (and usually deleted) branch.
- Its first branch hasn't been rebased onto the real trunk.
- Its PR base still targets the merged branch.

The CLI's `st sync` already knows how to heal this state
(`src/commands/sync.ts:55–88`): if the primary parent's branch is merged,
it rewrites `trunk` to the default branch, deletes `dependsOn`, and
rebases. We want the daemon to do the equivalent automatically, end-to-end.

Observed today (from `st daemon attach` during a real merge):

```
14:58:25 ← pull_request: #1265 merged
14:58:25   gemini-transcripts Merge-ready: PR #1265 merged, updating stack
14:58:25   gemini-transcripts PR #1265 merged in stack "gemini-transcripts" — cascading...
14:58:25 + gemini-transcripts Stack "gemini-transcripts" fully merged
14:58:25 $ gemini-transcripts git fetch origin
14:58:25 ← push: main (0708176)
14:58:27 ← push: dugshub/gemini-transcripts/4-gemini-transcript-wiring (0000000)
```

A downstream stack that depended on `gemini-transcripts` was not touched.

## Goal

After handling the in-stack cascade for a PR merge, the daemon should find
every stack that declares a dependency on the merged branch and — for each
— rebase onto the parent's trunk, push, post `rebase-status`, retarget the
first PR, and update state to drop the parent entry. Then cascade the
remaining branches inside that dependent stack.

## Non-goals (phase 1)

- **Multi-parent (diamond) dependents** are out of scope per
  `specs/2026-04-14-multi-parent-stacks.md`. A dependent whose `dependsOn`
  array has ≥2 entries is logged and skipped; the user recovers with
  `st sync` manually.
- **Recursive dependents of dependents**: after a dependent `D` is healed,
  any stack that depends on **`D`'s own branches** is untouched by design
  — `D`'s branch names and SHAs are still valid references. The chain only
  needs a push when a branch in it is actually merged.
- **No new webhook types, no new API endpoints.**

## Design

### Where the logic lives

Extend `src/server/index.ts:handlePRMerged`. After the existing in-stack
cascade block completes (whether it ran or was a no-op on a fully-merged
stack), run a new `cascadeToDependents(...)` step.

The in-stack cascade already captures everything we need before any
state mutation:

```ts
const mergedBranch = stack.branches[branchIndex];
const oldBase = mergedBranch?.tip;       // tip of the merged branch pre-merge
const mergedName = mergedBranch?.name;   // name for dependsOn matching
const parentTrunk = stack.trunk;         // what dependents should rebase onto
```

These are captured **before** `stack.branches.splice(branchIndex, 1)` runs,
so they remain valid for dependent processing afterwards.

### State shape extension

Today `src/server/stack-checks.ts` declares a minimal `StackFile` that does
**not** include `dependsOn`:

```ts
interface StackFile {
  repo: string;
  stacks: Record<string, {
    trunk: string;
    branches: Array<{ name: string; pr: number | null; tip: string | null }>;
  }>;
}
```

Widen it to carry `dependsOn` in both legacy object form and array form
(matches what the CLI writes to disk per `specs/2026-04-14-multi-parent-stacks.md`):

```ts
interface StackParent { stack: string; branch: string; }

interface StackFile {
  repo: string;
  stacks: Record<string, {
    trunk: string;
    dependsOn?: StackParent | StackParent[];   // new — both shapes allowed
    branches: Array<{
      name: string;
      pr: number | null;
      tip: string | null;
      parentTip?: string | null;   // preserved on write; updated after cascade
    }>;
  }>;
}
```

### New helpers in `src/server/stack-checks.ts`

```ts
/** Normalise dependsOn to an array regardless of on-disk shape. */
function parentsOf(stack: StackFile['stacks'][string]): StackParent[] {
  const d = stack.dependsOn;
  if (!d) return [];
  return Array.isArray(d) ? d : [d];
}

/** Find stacks whose dependsOn references the given (stackName, branchName). */
export function findDependentStacks(
  state: StackFile,
  parentStackName: string,
  parentBranchName: string,
): Array<{ stackName: string; stack: StackFile['stacks'][string] }> {
  const out: Array<{ stackName: string; stack: StackFile['stacks'][string] }> = [];
  for (const [stackName, stack] of Object.entries(state.stacks)) {
    if (parentsOf(stack).some(p =>
      p.stack === parentStackName && p.branch === parentBranchName)) {
      out.push({ stackName, stack });
    }
  }
  return out;
}

export { parentsOf };
```

### State write: preserve on-disk compat

`saveStackStateForRepo` currently writes the state object via
`JSON.stringify` directly. The CLI (`src/lib/state.ts:saveState`) collapses
single-element `dependsOn` arrays back to the legacy object shape on
disk so older CLI builds keep reading the file. The daemon must do the
same when it writes — otherwise a daemon-write produces a file an older
CLI can't parse.

Update `saveStackStateForRepo` (`src/server/stack-checks.ts:75`) to apply
the same collapse rule before writing:

```ts
export function saveStackStateForRepo(fullRepoName: string, state: StackFile): void {
  const found = findStateFile(fullRepoName);
  if (!found) return;
  const serializable = {
    ...state,
    stacks: Object.fromEntries(
      Object.entries(state.stacks).map(([name, s]) => {
        const parents = parentsOf(s);
        if (parents.length === 0) {
          const { dependsOn: _drop, ...rest } = s;
          return [name, rest];
        }
        if (parents.length === 1) {
          return [name, { ...s, dependsOn: parents[0] }];
        }
        return [name, { ...s, dependsOn: parents }];
      }),
    ),
  };
  const tmpPath = `${found.filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(serializable, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, found.filePath);
}
```

### New function: `cascadeToDependents`

Add to `src/server/index.ts` next to `handlePRMerged`:

```ts
async function cascadeToDependents(
  repo: string,
  state: StackFile,
  parentStackName: string,
  mergedBranchName: string,
  mergedBranchTip: string,   // old base for rebase --onto
  parentTrunk: string,        // new base; what dependent should rebase onto
): Promise<void> {
  const dependents = findDependentStacks(state, parentStackName, mergedBranchName);
  if (dependents.length === 0) return;

  const I = true;
  const clonePath = await ensureClone(repoUrl(repo), repoName(repo));
  // fetch already ran in the in-stack cascade; but when the parent stack was
  // fully merged we short-circuited before fetching. Fetch once here to cover
  // that case — fetchClone is serialised per clone path in clone.ts.
  log('info', `git fetch origin`, parentStackName, 'git', I);
  await fetchClone(clonePath);

  for (const { stackName: depName, stack: depStack } of dependents) {
    // Phase-1 scope: skip diamond dependents.
    if (parentsOf(depStack).length > 1) {
      log('warn',
        `Dependent stack "${depName}" has multiple parents — skipping (run \`st sync\` manually).`,
        depName);
      continue;
    }

    if (isStackLocked(depName)) {
      log('info', `Stack "${depName}" locked by CLI — skipping dependent sync`, depName);
      continue;
    }

    const firstBranch = depStack.branches[0];
    if (!firstBranch) {
      log('warn', `Dependent "${depName}" has no branches — skipping`, depName);
      continue;
    }

    log('info',
      `Cascading to dependent stack "${depName}" — rebasing ${firstBranch.name} onto ${parentTrunk}`,
      depName);

    const preSha = await getBranchSha(clonePath, firstBranch.name);

    // Resolve the effective `oldBase` for rebase --onto. `mergedBranchTip`
    // is the authoritative value from state, but if the recorded tip is
    // stale (e.g. a force-push happened between state write and merge),
    // fall back to `git merge-base parentTrunk firstBranch`. This matches
    // the fallback pattern in `src/lib/rebase.ts:rebaseBranch`.
    let effectiveOldBase = mergedBranchTip;
    const mbRes = await gitAsync(
      ['merge-base', parentTrunk, firstBranch.name],
      { cwd: clonePath },
    );
    if (mbRes.ok && mbRes.stdout.trim() && mbRes.stdout.trim() !== mergedBranchTip) {
      // If the stored tip is not an ancestor of firstBranch, the stored
      // value is stale; use the merge-base instead.
      const ancestor = await gitAsync(
        ['merge-base', '--is-ancestor', mergedBranchTip, firstBranch.name],
        { cwd: clonePath },
      );
      if (!ancestor.ok) {
        effectiveOldBase = mbRes.stdout.trim();
        log('warn',
          `Stored tip ${mergedBranchTip.slice(0, 7)} not on ${firstBranch.name} — falling back to merge-base ${effectiveOldBase.slice(0, 7)}`,
          depName, undefined, I);
      }
    }

    log('info',
      `git rebase --onto ${parentTrunk} ${effectiveOldBase.slice(0, 7)} ${firstBranch.name}`,
      depName, 'git', I);
    const rebase = await rebaseInWorktree(clonePath, {
      branch: firstBranch.name,
      onto: parentTrunk,
      oldBase: effectiveOldBase,
    });
    if (!rebase.ok) {
      log('error',
        `Rebase failed for ${firstBranch.name}: ${rebase.error}`,
        depName, undefined, I);
      continue;
    }
    log('success', `Rebased ${firstBranch.name} onto ${parentTrunk}`, depName, undefined, I);

    // Update state first so any follow-up webhook reads the new parent.
    const postSha = await getBranchSha(clonePath, firstBranch.name);
    const parentTrunkSha = await getBranchSha(clonePath, parentTrunk);
    firstBranch.tip = postSha;
    // parentTip records parent's tip at time of rebase — keeps future
    // CLI restacks using the correct exclusion SHA.
    (firstBranch as unknown as { parentTip?: string | null }).parentTip = parentTrunkSha;
    depStack.trunk = parentTrunk;
    // Remove the merged-parent entry from dependsOn (single-parent case: drop entirely)
    const remaining = parentsOf(depStack).filter(p =>
      !(p.stack === parentStackName && p.branch === mergedBranchName));
    if (remaining.length === 0) {
      delete depStack.dependsOn;
    } else {
      depStack.dependsOn = remaining;   // saveStackStateForRepo collapses shapes
    }
    saveStackStateForRepo(repo, state);

    log('info',
      `git push --force-with-lease ${firstBranch.name} (${preSha.slice(0, 7)})`,
      depName, 'git', I);
    const push = await pushBranch(clonePath, firstBranch.name, preSha);
    if (!push.ok) {
      log('error', `Push failed for ${firstBranch.name}: ${push.error}`, depName, undefined, I);
      continue;
    }
    const newSha = await getBranchSha(clonePath, firstBranch.name);
    log('success',
      `Pushed ${firstBranch.name} (${preSha.slice(0, 7)} → ${newSha.slice(0, 7)})`,
      depName, undefined, I);

    // rebase-status success
    log('info', `POST statuses/${newSha.slice(0, 7)} — rebase-status=success`,
      depName, 'api', I);
    await ghAsync('api', `repos/${repo}/statuses/${newSha}`,
      '-f', 'state=success', '-f', 'context=stack/rebase-status',
      '-f', `description=Rebased on ${parentTrunk}`);

    // Retarget first branch's PR to the new trunk.
    if (firstBranch.pr) {
      log('info', `gh pr edit #${firstBranch.pr} --base ${parentTrunk}`, depName, 'api', I);
      await ghAsync('pr', 'edit', String(firstBranch.pr), '--base', parentTrunk);
      log('success', `Retargeted #${firstBranch.pr} to ${parentTrunk}`, depName, undefined, I);
    }

    // Cascade through the rest of depStack's branches. For branch `b` at
    // index `i`, the correct `oldBase` for `git rebase --onto prev.name
    // <oldBase> b.name` is the PARENT's (prev's) OLD tip — the commit
    // that was at prev.name before we just rebased it. Snapshot all tips
    // BEFORE starting so we have each prev's pre-rebase SHA.
    //
    // Seed with firstBranch's pre-rebase SHA (we captured it above as
    // `preSha`) and the pre-rebase tips of every subsequent branch.
    const oldTips = new Map<string, string>();
    oldTips.set(firstBranch.name, preSha);
    for (let i = 1; i < depStack.branches.length; i++) {
      const b = depStack.branches[i];
      if (!b) continue;
      // Prefer the stored `tip` (state matches the remote). Fall back to
      // resolving the ref in the bare clone if state is missing it.
      if (b.tip) {
        oldTips.set(b.name, b.tip);
      } else {
        const sha = await getBranchSha(clonePath, b.name).catch(() => '');
        if (sha) oldTips.set(b.name, sha);
      }
    }

    for (let i = 1; i < depStack.branches.length; i++) {
      const b = depStack.branches[i];
      const prev = depStack.branches[i - 1];
      if (!b || !prev) continue;
      const oldPrevTip = oldTips.get(prev.name);   // PREVIOUS branch's OLD tip
      if (!oldPrevTip) {
        log('warn', `No old tip recorded for ${prev.name} — skipping cascade at this link`, depName);
        break;
      }
      const bPre = await getBranchSha(clonePath, b.name);
      log('info', `git rebase --onto ${prev.name} ${oldPrevTip.slice(0, 7)} ${b.name}`,
        depName, 'git', I);
      const r = await rebaseInWorktree(clonePath, {
        branch: b.name,
        onto: prev.name,
        oldBase: oldPrevTip,
      });
      if (!r.ok) {
        log('error', `Rebase failed for ${b.name}: ${r.error}`, depName, undefined, I);
        break;
      }
      const postBSha = await getBranchSha(clonePath, b.name);
      const newPrevTip = await getBranchSha(clonePath, prev.name);
      b.tip = postBSha;
      (b as unknown as { parentTip?: string | null }).parentTip = newPrevTip;
      saveStackStateForRepo(repo, state);
      log('info', `git push --force-with-lease ${b.name}`, depName, 'git', I);
      const rp = await pushBranch(clonePath, b.name, bPre);
      if (!rp.ok) {
        log('error', `Push failed for ${b.name}: ${rp.error}`, depName, undefined, I);
        break;
      }
      // rebase-status success (branch is on top of its new parent)
      const sha = await getBranchSha(clonePath, b.name);
      await ghAsync('api', `repos/${repo}/statuses/${sha}`,
        '-f', 'state=success', '-f', 'context=stack/rebase-status',
        '-f', `description=Rebased on ${prev.name}`);
    }

    log('success', `Dependent stack "${depName}" synced onto ${parentTrunk}`, depName);
  }
}
```

### Wiring into `handlePRMerged`

Inside `handlePRMerged` (`src/server/index.ts:47`):

1. Capture `mergedName` alongside the existing `oldBase` before splicing:
   ```ts
   const mergedBranch = stack.branches[branchIndex];
   const oldBase = mergedBranch?.tip;
   const mergedName = mergedBranch?.name;
   const parentTrunk = stack.trunk;
   ```

2. At the two existing exit points, call the dependent cascade with these
   captured values instead of just returning:

   - **Fully-merged branch** (current line 65, `if (remaining.length === 0)`):
     after logging `Stack "..." fully merged`, instead of `return`, call
     `await cascadeToDependents(repo, state, stackName, mergedName, oldBase!, parentTrunk)`
     (skip only if `oldBase`/`mergedName` missing — same guard the
     in-stack cascade uses).

   - **After the in-stack cascade completes** (current end of function,
     post-retarget): call the same `cascadeToDependents(...)` before
     returning.

3. Error handling: `cascadeToDependents` logs its own errors and never
   throws — each dependent is independent. The outer `.catch` in the
   webhook router (`src/server/index.ts:178`) already handles unexpected
   throws, so we also wrap the call in a `try/catch` that logs and
   swallows just in case.

### Concurrency / races

- `handlePRMerged` already runs on a per-webhook basis (fire-and-forget).
  We don't change that.
- `saveStackStateForRepo` writes atomically (tmp + rename).
- `fetchClone` is already serialised per clone path by `fetchLocks`.
- CLI locks (`isStackLocked`) are checked per dependent, mirroring the
  in-stack guard.
- If two PRs in the same merged stack land near-simultaneously, they each
  trigger an independent `cascadeToDependents`. Both will race on the
  same dependent stack's rebase/push. The later one will fail its
  `--force-with-lease` push (good — safe) and log an error. A follow-up
  `st sync` recovers. This matches the existing in-stack behaviour and
  is acceptable for phase 1.

### What about the primary-branch-tip updates when a dependent is itself deep?

When a dependent `D` has branches `D1, D2, D3`, and `D1` moves (rebase onto
new trunk), `D2` and `D3` need to rebase onto the *new* `D1`. The spec
includes that cascade inline (the second `for` loop in
`cascadeToDependents`). We **intentionally** do this with the bare-clone
primitive rather than calling out to `st sync`, matching the design
decision in `specs/2026-03-21-daemon-merge-redesign.md` (the daemon does
not shell to `st`).

### What about `currentStack`?

The CLI's `sync` clears `state.currentStack` when a stack is fully merged.
The daemon must not touch `currentStack` — it reflects the user's terminal
context, not a cascade concern. Leave it alone.

## Files changed

1. `src/server/stack-checks.ts`:
   - Extend `StackFile` interface to include `dependsOn?: StackParent | StackParent[]` on stack entries; add `StackParent` interface.
   - Add `parentsOf(stack)` helper.
   - Export `findDependentStacks(state, parentStackName, parentBranchName)`.
   - Update `saveStackStateForRepo` to collapse/normalise `dependsOn` on write (matches CLI's `saveState`).

2. `src/server/index.ts`:
   - Import `findDependentStacks`, `parentsOf` (or re-export) from `stack-checks.ts`.
   - Capture `mergedName`/`parentTrunk` in `handlePRMerged`.
   - Call `cascadeToDependents(...)` at both exit points (fully-merged + post-retarget).
   - Add `cascadeToDependents(...)` function.

No other files change.

## Test plan (manual — no test suite)

1. **Baseline regression** — single stack, no dependents. Merge a PR.
   Verify existing cascade still works; daemon log ends with retarget
   (or fully-merged) as today.
2. **Single-parent dependent, parent not fully merged.** Stacks `A (A1,
   A2)` and `B` with `dependsOn: {A, A1}`. Merge `A1`. Expect:
   - `A2` rebased onto main (existing behaviour).
   - `B1` rebased onto main; `B.trunk = main`; `B.dependsOn` removed.
   - `B1` PR retargeted to main.
3. **Single-parent dependent, parent fully merged.** Stacks `A (A1)` and
   `B` with `dependsOn: {A, A1}`. Merge `A1`. Expect:
   - Log `Stack "A" fully merged`.
   - `B1` rebased and retargeted; `B` is now standalone.
4. **Deep dependent chain.** `B` has branches `B1, B2, B3`. Parent branch
   merges. Expect all three to be rebased and pushed, each with a
   `rebase-status=success`.
5. **Multiple dependents on same parent.** `B` and `C` both depend on
   `A@A1`. Merge `A1`. Both should be synced.
6. **Diamond dependent (skip).** `D` depends on both `A@A1` and `A'@X1`.
   Merge `A1`. Daemon logs `skipping (run \`st sync\` manually)` and
   does nothing to `D`.
7. **Locked dependent (skip).** `B` has a CLI sync lock. Merge `A1`.
   Daemon logs `skipping dependent sync` and does nothing to `B`.
8. **On-disk format compat.** After the daemon writes state for case 2,
   open the state file. Single-parent stacks remain `dependsOn: { ... }`
   object form; a stack with 0 parents has no `dependsOn` key; a stack
   with 2+ parents is written as an array. Run an older `st` build
   against the file and confirm it still loads.
9. **Typecheck / lint.** `bun x tsc --noEmit` passes; `bun run src/cli.ts --help` runs; `st submit --dry-run` on an existing stack still works.

## Rollback

All changes are additive:
- New function `cascadeToDependents` — guarded by `findDependentStacks`
  returning empty on states that don't use the feature.
- `saveStackStateForRepo` collapse logic — preserves existing
  object-form-on-disk for the single-parent case, so older CLIs read
  files just like they do today.

If phase 1 ships and misbehaves, reverting the two changed files restores
the prior daemon behaviour; state files produced in the interim remain
readable because of the on-disk collapse.

## Addressed in review

- **Inner cascade uses prev's old tip, not b's.** For branch at index `i`,
  the `--onto` exclusion SHA is the PARENT's old tip (`prev.name`'s
  pre-rebase SHA). The first iteration seeds from `preSha` (the first
  branch's pre-rebase SHA), subsequent iterations from stored `tip`.
- **Stale `mergedBranchTip`.** Added a merge-base fallback: if the stored
  tip is not an ancestor of the dependent's first branch, we compute
  `git merge-base parentTrunk firstBranch` and use that instead.
- **`parentTip` written on every cascade step.** Keeps future CLI
  `st sync`/`st restack` operations using the correct exclusion SHA.
- **Partial failure is recoverable.** State is saved after each push, so
  `st sync` or the next webhook can resume. `rebase-status` commit
  statuses posted before a later failure are harmless — the push webhook
  re-checks them.

## Open questions

- Do we want to also enable auto-merge on the dependent's first PR once
  it's retargeted and its `rebase-status` is green? The CLI does not, and
  `st merge` is the explicit user gesture. Phase 1: don't.
- Should we post a stack navigation comment on the dependent's PRs after
  retarget (to reflect the new trunk)? Current daemon doesn't do this for
  the in-stack cascade either. Defer to a follow-up.
