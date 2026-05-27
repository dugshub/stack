# `st sync` reconciles trunk movement (not just merges)

## Problem

`st sync` is meant to reconcile a stack with remote reality. Today it only reacts to **merged PRs** (and a merged/deleted trunk). When `main` (or any trunk) simply *advances* on the remote — someone else merged unrelated work — but no PR in the stack is merged, sync fetches and then bails:

```
$ st sync
Fetching from origin...
Nothing to sync — no merged PRs.
```

The user is left to manually `git checkout main && git pull && st restack` before their stack sits on top of the latest trunk. `st restack` is no help on its own: it never fetches and rebases onto the **stale local trunk**.

A trunk that moved is the same class of event as a PR that merged — "the base under my stack changed." The early-bail at `src/commands/sync.ts:103` is an artificial gate. The fetch + fast-forward + cascade-rebase machinery that handles the merged case is already in `sync` and works correctly for a moved trunk (branch 0's stored `parentTip` is the old trunk tip, so `rebase --onto <newTrunk> <oldParentTip>` replays cleanly).

## Scope

**In:**
- Detect "trunk advanced on remote" as a first-class sync trigger (`trunkMoved`), alongside merged PRs and trunk-merged conversion.
- When only the trunk moved (no merges): fast-forward local trunk to `origin/<trunk>` and cascade-rebase the whole stack onto it — reusing the existing rebase/conflict/resume path.
- Keep an idempotent sync a true no-op: if nothing merged **and** trunk did not move, still print "Nothing to sync" and rewrite no SHAs.
- Skip the PR-retarget pass when nothing merged (there is nothing to retarget; avoid pointless `gh pr edit` calls).
- Generalizes to dependent stacks: there "trunk" is the parent branch, so a moved parent triggers the same reconcile.
- Update the shipped skill (`.claude/skills/stack/SKILL.md`) sync description + workflow, bump version, add changelog entry.

**Out:**
- No `--pull` flag on `restack` and no new `st pull` command. (Decision: this behavior belongs in `sync`, the existing "reconcile with remote" verb. `restack` stays purely local.)
- No change to push behavior — sync rebases; the user still runs `st submit` to push, exactly as today after a merge-driven sync. (A hint nudging `st submit` is optional, below.)
- No change to the conflict/resume protocol — `st continue` / `st abort` already drive sync's rebase via `restackState`; the trunk-only path reuses it unchanged.

## Current behavior (reference)

`src/commands/sync.ts`:
- Line 53: `git.fetch()`.
- Lines 57–88: dependent-stack handling — if trunk was merged/deleted, convert to standalone (`trunkChanged = true`).
- Lines 91–101: scan PRs, collect `mergedIndices`.
- **Lines 103–108: early return** when `mergedIndices.length === 0 && !trunkChanged` → "Nothing to sync". ← the gap.
- Lines 116–163: pass-1 PR retarget (only meaningful when branches were removed).
- Lines 213–233: checkout trunk + `merge --ff-only origin/<trunk>`.
- Lines 236–291: rebase branch 0 onto trunk, then `cascadeRebase` the rest; on conflict, set `restackState` and exit 1.
- Lines 293–386: refresh PR comments, navigate, update statuses, success message.

## Design

### 1. Detect `trunkMoved` (right after fetch, BEFORE the dependent-stack block)

Insert immediately after `git.fetch()` (`sync.ts:53`) and **before** the dependent-stack block at `sync.ts:57` — because that block can mutate `stack.trunk` (parent branch → default branch when `trunkChanged` fires). Capturing the signal against the *original* trunk avoids a spurious `trunkMoved = true` when the trunk was merged and converted. Compute whether the remote trunk differs from what the stack is currently based on:

```ts
// Did the trunk advance on the remote since we last rebased onto it?
// The stack's recorded base point is branch 0's parentTip (trunk tip at last rebase).
let trunkMoved = false;
{
  const firstBranch = stack.branches[0];
  if (firstBranch?.parentTip && git.hasRemoteRef(stack.trunk)) {
    const remoteTrunkTip = git.revParse(`origin/${stack.trunk}`);
    trunkMoved = remoteTrunkTip !== firstBranch.parentTip;
  }
}
```

Notes:
- Use `origin/<trunk>` (post-fetch) as the source of truth, so it also catches the case where the user already fast-forwarded local trunk but never rebased the stack.
- `firstBranch.parentTip` is the trunk tip captured at the last rebase (`rebase.ts:52`). If it differs from the remote trunk tip, the base moved → rebase. (Difference covers both "advanced" and "force-pushed/diverged"; `rebase --onto` handles both.)
- Guard on `hasRemoteRef`: a local-only trunk can't be pulled; treat as not moved.
- If `branches` is empty, `trunkMoved` stays false (nothing to rebase) — and an empty stack with no merges falls through to the existing "Nothing to sync" path.
- `trunkChanged` (trunk merged → converted to standalone) already forces the rebase path; leave it as-is. Because `trunkMoved` is computed against the *original* trunk before the conversion, the two flags are independent and there is no spurious interaction. (If for any reason the detection is instead placed after `sync.ts:88`, it MUST be guarded with `!trunkChanged`, since by then `stack.trunk` points at the new default branch and the comparison would be meaningless.)

### 2. Add `trunkMoved` to the early-return gate

`sync.ts:103`:

```ts
// before
if (mergedIndices.length === 0 && !trunkChanged) {

// after
if (mergedIndices.length === 0 && !trunkChanged && !trunkMoved) {
```

When `trunkMoved` is the only trigger, control proceeds into the existing rebase block.

**Also guard the `Found N merged PR(s).` line** (`sync.ts:110`), which sits *after* the gate. In a trunk-only sync it would print "Found 0 merged PR(s)." — wrap it so it only prints when there are merges:

```ts
if (mergedIndices.length > 0) {
  ui.info(`Found ${mergedIndices.length} merged PR(s).`);
}
```

### 3. Skip PR-retarget pass when nothing merged

The pass-1 retarget loop (`sync.ts:116–163`) recomputes each unmerged PR's base after merged branches are removed. With zero merges, every branch's parent is unchanged, so the loop would issue a `gh pr edit --base <same>` for every PR — wasteful API calls and noisy output. Guard it:

```ts
// before
if (!allMerged) {

// after
if (!allMerged && mergedIndices.length > 0) {
```

(`mergedBranchTip` at `sync.ts:165–188` already stays `null` when nothing merged — `firstRemainingIdx` is 0 and the backward walk finds no merged branch — so branch 0's rebase uses `branch.parentTip` as its old base. Note `parentTip` is the *primary* choice in `rebaseBranch`'s `oldBase` chain (`rebase.ts:29–37`), tried before `fallbackOldBase` and `merge-base` — it is exactly what makes the trunk-only rebase correct, not a last resort. No change needed there.)

### 4. Messaging

- When `trunkMoved && mergedIndices.length === 0 && !trunkChanged`, before the rebase block, print an informative line, e.g.:
  `ui.info(\`Trunk \${theme.branch(stack.trunk)} advanced — rebasing stack onto it.\`)`
- Adjust the final success message (`sync.ts:382`) so a trunk-only sync doesn't read "removed 0 merged". Suggested:
  - if `mergedIndices.length > 0`: keep `removed N merged, M remaining`.
  - else (trunk-only): `Synced stack <name>: rebased M branches onto <trunk>`.
- Optional, low-priority: when branches were rebased (any path) and have open PRs, end with a hint `Run \`st submit\` to push.` — only if it doesn't duplicate an existing nudge. Keep out if it adds noise.

### 5. Conflict / resume — no new code

If the trunk-only rebase conflicts, the existing branch-0 conflict handler (`sync.ts:258–278`) and `cascadeRebase`'s conflict path set `restackState = { fromIndex: -1, currentIndex, oldTips }` and exit 1. `st continue` (`src/commands/continue.ts`) resumes from `restackState` and re-cascades; `st abort` restores. Verify the trunk-only path produces the same `restackState` shape — it does, because it flows through the same code. No changes to `continue`/`abort`.

### 6. Dependent stacks

For a dependent stack, `stack.trunk` holds the **parent branch name**, and `origin/<parent>` exists once the parent is pushed. The same detection fires when the parent advances, and the existing `merge --ff-only origin/<trunk>` fast-forwards the local parent branch before rebasing. This is desirable and consistent: `st sync` on a dependent stack now reconciles it onto the latest parent even when nothing merged. No special-casing required. (The pre-existing trunk-merged→standalone conversion at `sync.ts:57–88` still runs first and is unaffected.)

## Files to change

| File | Change |
|------|--------|
| `src/commands/sync.ts` | Add `trunkMoved` detection; add it to early-return gate; guard retarget pass with `mergedIndices.length > 0`; add trunk-moved info line; adjust final success message. |
| `.claude/skills/stack/SKILL.md` | Update `st sync` one-liners (lines ~19 "Clean up after merges on GitHub", ~75 "Fetch, remove merged branches, rebase remaining") to "Fetch, pull trunk, remove merged branches, rebase remaining". Add a "Trunk moved on `main`" recovery entry showing `st sync` handles it. Disambiguate the existing "Branch got out of sync" entry (lines ~255–259) so it no longer implies `st restack` is the answer for trunk movement — e.g. "`st restack` for mid-stack edit drift; use `st sync` when trunk moved on the remote". |
| `package.json` | Patch version bump (0.9.7 → 0.9.8). |
| `CHANGELOG.md` | New 0.9.8 entry: "`st sync` now rebases your stack when the trunk advanced on the remote, not only when a PR merged — no more manual `git pull` + `st restack`." |

No changes to `src/lib/rebase.ts`, `continue.ts`, `abort.ts`, `state.ts`, or `types.ts`. No `st status --json` shape change → `stack-management/SKILL.md` untouched.

## Verification

No test suite exists; verify manually:

1. **Trunk-only sync (the target case):**
   - Create a stack on `main`. Push an unrelated commit to `origin/main` (simulate via a second clone or `git commit` on main + `git push`, or a throwaway branch merged into main on GitHub).
   - `st sync` → expect: fetch, "Trunk main advanced — rebasing…", branches rebased onto new main, success message reads "rebased N branches onto main".
2. **Idempotent no-op:** immediately run `st sync` again → "Nothing to sync — no merged PRs." and **no** branch SHAs change (`st status` shows same tips). This confirms the `trunkMoved` guard is tight.
3. **Merged-PR path unchanged:** merge the bottom PR on GitHub, `st sync` → still removes the merged branch, retargets, rebases (regression check that step 3's guard didn't break the merge flow).
4. **Conflict + resume:** force a conflict between a stack branch and a new trunk commit; `st sync` → conflict, exit 1, `restackState` persisted; resolve + `st add` + `st continue` → completes. `st abort` from the conflicted state restores.
5. **Dependent stack:** advance a parent stack branch on remote; `st sync` on the dependent → rebases onto the updated parent.
6. `st sync --dry-run`? — sync has no `--dry-run`; not in scope. Confirm `st submit --dry-run` still plans correctly after a trunk-only sync.

## Risks

- **Over-eager rebase / SHA churn.** Mitigated by the `trunkMoved = remoteTrunkTip !== firstBranch.parentTip` guard — a genuinely up-to-date stack rewrites nothing. The verification step 2 explicitly checks this.
- **`parentTip` missing on legacy branches.** If `branches[0].parentTip` is null (pre-`parentTip` state), `trunkMoved` is false and behavior is exactly as today (no regression; user can still get the old manual flow). Acceptable — `parentTip` has been populated since the smart-restack spec.
- **Detached/odd trunk names.** Guarded by `hasRemoteRef`.
