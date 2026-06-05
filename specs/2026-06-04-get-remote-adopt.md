# `st get` — adopt the remote version of a stack + auto-adopt in `st sync`

**Date:** 2026-06-04
**Version target:** 0.9.13 (patch bump)

## Problem

The daemon restacks and force-pushes stack branches, making `origin/*` the source of
truth. A stale local checkout (different worktree/session, or simply not pulled) that
then runs `st sync` rebases its *stale local commits* onto trunk — duplicating or
conflicting with the rebase the daemon already performed and pushed. There is no
command today that adopts remote stack refs over local ones:

- `st sync` only ever fast-forwards the *trunk* (`fastForwardLocalBranch`,
  `src/commands/sync.ts:248`) — never the stack branches.
- `git.resetHard` exists only for `st undo`'s local snapshot restore
  (`src/lib/undo.ts:143`).

## Goals

1. New command **`st get`**: fetch, then per stack branch adopt `origin/<branch>`
   when it is safe (no un-pushed local work), updating state so subsequent
   restacks compute correct ranges.
2. **`st sync` auto-adopts** silently before doing anything else, using the same
   safety predicate. When local has divergent un-pushed work, warn and point at
   `st get --force` — never adopt destructively without the flag.
3. Snapshot first (`saveSnapshot('get')`) so `st undo` reverts a bad adoption.

## Non-goals

- Handling merged/deleted remote branches in `st get` (that is `st sync`'s job —
  `st get` skips branches with no remote ref).
- Pulling *state file* contents from anywhere (state remains local; only git refs
  and recorded tips/parentTips change).
- New persistent state fields. A `lastPushedTip` field was considered and
  rejected: `refreshTips()` (`src/lib/state.ts:192`) rewrites `branch.tip` from
  the local ref on every command load, so recorded-tip-based detection is
  unreliable by construction, and a new field recorded at push time wouldn't
  exist for pre-0.9.13 stacks anyway. The predicate is derived purely from git.

## Design

### Safety predicate — "is it safe to adopt `origin/<br>` over local `<br>`?"

Evaluated per branch, in order. Implemented in a new shared module
`src/lib/remote-adopt.ts` so `get` and `sync` share one implementation.

| # | Condition | Classification | Action |
|---|-----------|----------------|--------|
| 0 | no `origin/<br>` ref | `no-remote` | skip (info) |
| 1 | `rev-parse <br>` == `rev-parse origin/<br>` | `in-sync` | nothing |
| 2 | local is ancestor of remote (`merge-base --is-ancestor`) | `behind` | adopt — pure fast-forward, zero risk |
| 3 | diverged, but `git cherry origin/<br> <br>` has **no `+` lines** — every local-only commit is patch-equivalent to a remote commit | `rewritten` | adopt — remote is a rebase of the same patches (the daemon case) |
| 4 | diverged with `+` lines (real local-only patches) | `diverged` | skip + warn; adopt only under `--force` |

Notes:

- `git cherry <upstream> <head>` marks each commit in `<head>`-not-`<upstream>`
  with `+ <sha>` (no patch-equivalent upstream) or `- <sha>` (equivalent exists). Add a
  `git.cherry(upstream, head): { sha: string; equivalent: boolean }[]` helper to
  `src/lib/git.ts` (via `tryRun`; a failed run / non-zero exit → treat as
  `diverged`, i.e. fail safe). Module doc must note: **call cherry only after
  the case-2 ancestry check failed** — on a pure fast-forward cherry's empty
  output is ambiguous, so reordering these checks would be a bug.
- Join branches (diamond stacks, `branch.parentTips != null`): `git cherry`
  skips merge commits (they have no patch-id), so a join branch whose local/remote
  difference is only the re-created merge commit classifies `rewritten` and is
  adopted — correct. Replay commits after the merge participate in cherry normally.
- Known false-negative, accepted deliberately: a rebase that changed a commit's
  *context lines* (e.g. conflict resolution) changes its patch-id, so case 3
  reports `+` and we classify `diverged`. The escape hatch is `st get --force`.
  We bias toward never auto-destroying a commit whose content has no remote
  equivalent. Subject/author matching as a secondary heuristic was considered
  and rejected for auto-adoption: an amended commit keeps its subject, and
  adopting would silently discard the amendment.
- Case 2 (`behind`) covers an *empty* local-only range trivially (local==merge-base).

### Performing the adoption (per branch classified `behind`/`rewritten`, or `diverged` with `--force`)

Worktree handling (use `git.worktreeList()` like `rebase.ts`; identify the
*current* worktree by comparing map values against `git.repoRoot()`):

1. **Branch checked out in the current worktree (= the current branch)** —
   `git reset --hard origin/<br>` in place. **Dirty-session protection:** the
   command bodies run inside `withCleanWorktreeAsync`, whose auto-stash is
   popped *after* the reset — re-applying stashed changes on top of a different
   tip can conflict or silently mis-apply. So callers capture
   `git.isDirty()` **before** entering the wrapper and pass the current branch
   name as `AdoptOptions.protectBranch` when the session started dirty; the
   module classifies that branch `worktree-dirty` (skip + warn:
   `commit or stash your changes on <br>, then re-run`). Even `--force` does
   not override `protectBranch`.
2. **Branch not checked out anywhere** — `git branch -f <br> origin/<br>`
   (ref-only update; never touches a working tree).
3. **Branch checked out in another worktree** — if that worktree is clean
   (`git status --porcelain -uno` with `cwd`), run `git reset --hard origin/<br>`
   with `cwd` = that worktree. If dirty → classification becomes
   `worktree-dirty`: skip + warn (even under `--force` — we never clobber a dirty
   working tree we can't stash for).

After each adoption set `branch.tip = revParse(branch.name)`.

### Recomputing `parentTip`

After all adoptions for a stack, walk branches in order and set
`branch.parentTip = merge-base(parentRef, branch.name)` where `parentRef` is
`stack.trunk` for index 0 else `branches[i-1].name` — the same rule as
`backfillParentTips` (`src/lib/state.ts:209`). When the daemon rebased the stack
coherently, this merge-base *is* the parent's new tip. Recompute for **all
non-join** branches (not just adopted ones): an adopted parent shifts the
child's fork point even if the child itself was `in-sync`.

**Join branches (`branch.parentTips != null`) are exempt from the recompute
entirely** — both the `parentTips` map *and* the singular `parentTip`. Their
`parentTip` is defined as the *primary parent's* tip (`rebaseJoinBranch`,
`src/lib/rebase.ts:171`), which `merge-base(branches[i-1], joinBranch)` does
not express (positional predecessor ≠ primary parent). Leave both fields
as-is; if stale, `rebaseBranch`'s `isAncestor` validation
(`src/lib/rebase.ts:30`) already falls back to merge-base safely. Document
this v1 limitation in the module.

Persist with `saveState(state)`; `stack.updated = new Date().toISOString()`.

### Shared module API (`src/lib/remote-adopt.ts`)

```ts
export type AdoptClass = 'no-remote' | 'in-sync' | 'behind' | 'rewritten' | 'diverged' | 'worktree-dirty';
export interface AdoptResult { branch: string; classification: AdoptClass; adopted: boolean; }
export interface AdoptOptions {
  force?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  /** Branch to never adopt (classified worktree-dirty) — set by callers when
   *  the session started dirty, since the wrapper's auto-stash pops AFTER any
   *  reset. Not overridden by force. */
  protectBranch?: string;
}

/** Assumes `git fetch` already ran. Mutates branch tips/parentTips in `stack`,
 *  saves state when anything changed (not in dryRun). Emits ui.info/success per
 *  adopted branch unless quiet. Never throws on per-branch failures. */
export function adoptRemoteBranches(
  state: StackFile, stack: Stack, opts?: AdoptOptions,
): AdoptResult[];
```

### `st get` command (`src/commands/get.ts`)

- `static override paths = [['stack', 'get'], ['get']]` — auto-discovered by
  `cli.ts`, no registration edit needed.
- Flags: `--stack,-s <name>`, `--force` (adopt `diverged` branches too),
  `--dry-run` (classify + print plan, mutate nothing).
- Flow (mirrors sync's shape):
  1. Capture `protectBranch = git.isDirty() ? git.currentBranch() : undefined`
     **before** entering the `git.withCleanWorktreeAsync` wrapper (the wrapper
     stashes, so dirtiness is invisible afterwards); pass it through to
     `adoptRemoteBranches`.
  2. `loadAndRefreshState()`, `resolveStack` (same error handling as sync.ts:32-38).
  3. Refuse when `stack.restackState` is set (same message as sync.ts:42-47).
  4. `saveSnapshot('get')` (skip when `--dry-run`).
  5. `ui.info('Fetching from origin...')`; `git.fetch()`.
  6. Also fast-forward trunk: `git.fastForwardLocalBranch(stack.trunk, 'origin/<trunk>')`
     when the remote ref exists (consistent with sync).
  7. `adoptRemoteBranches(state, stack, { force, dryRun })`.
  8. Report: per-branch lines during the run; summary at the end —
     `Adopted N branch(es) from origin` / `Already up to date` / for each
     `diverged` skip: `⚠ <br> has local commits not on the remote — kept local.
     Re-run with --force to discard them.` / for `worktree-dirty`:
     `⚠ <br> is checked out in a dirty worktree (<path>) — skipped.`
  9. Exit 0 unless every requested adoption failed operationally (git errors) → 1.
     Skips (`diverged`, `worktree-dirty`, `no-remote`) are not failures.

### `st sync` integration (`src/commands/sync.ts`)

Immediately after `git.fetch()` (line 53) and **before** the `trunkMoved`
computation (lines 58-65), insert:

```ts
// Adopt remote branch refs when the remote is strictly ahead or a clean
// rewrite of the same patches (e.g. the daemon already restacked + pushed).
// Harmless by construction: only branches with no un-pushed local work move.
const adoptions = adoptRemoteBranches(state, stack, { protectBranch });
```

`protectBranch` is captured the same way as in `st get` — `execute()` reads
`git.isDirty() ? git.currentBranch() : undefined` before calling
`withCleanWorktreeAsync` and threads it into `executeInner`.

**Ordering vs the trunk-merged block (sync.ts:67-100):** adoption runs before
that block, which can later mutate `stack.trunk` (dependent stack whose base
merged) and re-save state. This is safe, deliberately: (a) both operate on the
same in-memory `state`, so the later `saveState` persists the adoption's
changes too; (b) an adopted `parentTip = merge-base(oldTrunk, branch)` remains
a valid *exclusion base* for the subsequent rebase onto the new trunk —
`rebase --onto newTrunk oldBase branch` replays exactly the branch-unique
commits, and `rebaseBranch`'s `isAncestor` guard falls back to merge-base if
the value were ever stale. Add a code comment to this effect.

- Adopted branches log a one-liner each (`↓ adopted origin/<br>`); `diverged`
  branches produce a single warning block at the end of the adoption pass:
  `⚠ <br> has local commits not on origin/<br> — keeping local. If the remote
  is the truth, run st get --force.` Sync then proceeds as today (it will rebase
  the kept-local branch — current behavior, just now with an explanation).
- Because adoption updates `parentTip` before `trunkMoved` is computed, a stack
  the daemon fully restacked yields `trunkMoved === false` and sync prints
  "Nothing to sync" instead of re-rebasing — that is the bug being fixed.
- Sync's existing snapshot (`saveSnapshot('sync')`, line 49) already precedes
  the insertion point — covers undo for the adoption too. No second snapshot.
- **Known limitation (document in ai-docs sync.details or workflows.md):** sync
  auto-adopts only the *resolved* stack. A dependent stack whose daemon-rewritten
  *parent stack* branches are stale locally needs `st get -s <parent>` first.

### Docs / surface updates (same PR, per CLAUDE.md rule)

- `src/lib/ai-docs.ts`: new `get` entry (group `stack`; flags `--stack,-s`,
  `--force`, `--dry-run`; description "Adopt the remote version of the stack
  (reset local branches to origin)"); amend `sync.details` to mention the
  auto-adoption pass.
- `.claude/skills/stack/references/workflows.md`: short "stale local stack /
  daemon already restacked" recovery flow (`st get`, `st get --force`).
  Check `references/recovery.md` — if it has a divergence section, prefer that file.
- `package.json` → `0.9.13`; `CHANGELOG.md` entry describing both the new
  command and sync's new behavior.

### Help/usage

`Command.Usage` description: "Adopt the remote version of the stack — reset
local branches to origin"; examples: `st get`, `st get --dry-run`,
`st get --force`.

## Tests

`src/commands/get.test.ts`, patterned on `absorb.test.ts` (temp repo +
state-file helpers). Fixture: bare "origin" repo (`git init --bare`), working
clone with a 3-branch stack pushed, plus a second clone acting as "the daemon"
that rebases the stack onto an advanced trunk and force-pushes. The CLI runs in
the first (stale) clone via `bun run cli.ts get ...`.

Cases:

1. `behind`: origin branch strictly ahead → adopted; local ref == origin SHA;
   state tip updated; parentTip == merge-base.
2. `rewritten` (the daemon scenario): trunk advanced; daemon clone rebases all
   branches + force-pushes; stale clone `st get` adopts all; ancestry chain
   intact (`merge-base --is-ancestor` parent → child for each pair).
3. `diverged`: stale clone commits new work on branch 2, daemon force-pushes a
   rewrite → branch 2 skipped with warning, others adopted; `--force` adopts
   branch 2 and the local-only commit is gone.
4. `in-sync` everywhere → "Already up to date", exit 0, no ref movement.
5. `no-remote`: stack branch never pushed → skipped with info, exit 0.
6. `--dry-run`: classifications printed, zero ref/state mutation (compare SHAs +
   state file before/after).
7. Worktree: branch checked out in a second worktree, clean → adopted via that
   worktree (its HEAD moves); dirty → skipped with warning even under `--force`.
7b. Dirty current branch: uncommitted changes on the current (adoptable) branch
   → that branch is skipped (`worktree-dirty`) with the "commit or stash" hint,
   the dirty changes survive untouched, and other branches still adopt.
8. Undo: after a `--force` adoption, `st undo` restores the pre-get local tips.
9. Sync auto-adopt: in the daemon scenario, `st sync` (branches with `pr: null`,
   so no `gh` calls fire in the merged-PR loop) adopts and reports nothing to
   sync; local refs match origin. *Caveat for builder:* the early-exit path
   calls `gh.updateMergeReadyStatuses` (sync.ts:117) — verify it degrades
   gracefully without `gh` auth in the test env (it batches over branches with
   PR numbers; with all `pr: null` it should no-op — confirm, and if it doesn't,
   guard the call rather than weakening the test).

Unit tests for the predicate live implicitly in 1-7; if the builder finds it
cleaner, a colocated `src/lib/remote-adopt.test.ts` may cover classification
directly with the same fixtures.

## Addendum (same PR): adopt upstream ancestor stacks too

The v1 limitation ("sync only auto-adopts the resolved stack; run `st get -s
<parent>` first") is removed. Both `st get` and `st sync` now walk the
dependency chain **upward** and adopt each ancestor stack before the resolved
stack.

- Collect ancestors via `stackParents(stack)` recursively (visited set —
  diamonds have multiple parents; cycles guarded like
  `cascadeDependentStacks`). Adopt in root-down topological order, resolved
  stack last.
- **`--force` applies only to the resolved stack.** Ancestor stacks always
  adopt with `force: false` (risk-free classes only); their `diverged`
  branches warn with `st get -s <ancestor> --force` as the hint.
- `protectBranch` applies to every stack's pass (the current branch may live
  in an ancestor).
- Skip ancestor stacks with a non-null `restackState` (warn + continue; do not
  abort the resolved stack's run).
- Per-ancestor output prefix so warnings are attributable, e.g.
  `↓ adopted origin/<br> (stack <name>)`.
- Downstream dependent stacks remain out of scope (sync's cascade handles them).
- Docs: drop the limitation sentence from `ai-docs.ts` `sync.details` and
  `recovery.md`; describe the ancestor walk instead. Amend the `get` entry +
  changelog accordingly (still 0.9.13).
- Tests (extend `get.test.ts`): dependent-stack fixture — stack A (2 branches
  off main) + stack B (`trunk` = A's top branch, `dependsOn` set); daemon
  clone rewrites A and B, force-pushes. Then:
  1. `st get` (on B) adopts A's branches and B's branches; ancestry intact
     across the seam (A top is ancestor of B bottom).
  2. Diverged branch *in A* + `st get --force` (on B): A's diverged branch is
     **not** force-adopted (warn suggests `st get -s A --force`); B's diverged
     branches are.
  3. `st sync` on B in the daemon scenario adopts both stacks and reports
     nothing to sync.

## Acceptance

- The user's incident replays clean: daemon restacks + pushes; a stale local cut
  runs `st sync`; result is adopted refs + "Nothing to sync" — no duplicate
  rebase, no conflicts.
- `bun test` passes; `st submit --dry-run` unaffected; `st --ai get` documents
  the new command.
