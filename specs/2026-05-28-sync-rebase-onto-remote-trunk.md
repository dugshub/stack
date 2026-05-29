# `st sync` rebases onto the remote trunk, not a stale local branch

## Problem

`st sync` (since v0.9.8, commit 810561f) reconciles a stack when the trunk moves —
fast-forward the local trunk, rebase the stack onto it. But it rebases onto the
**local** `<trunk>` branch ref, which it updates with a best-effort
`git merge --ff-only origin/<trunk>`. When that fast-forward can't happen, sync
proceeds anyway against a stale/wrong base. Two real failures (both reproduced):

- **Silent corruption (diverged local trunk).** If local `main` has diverged
  from `origin/main` (the user has local-only commits on `main`, or did a non-FF
  merge), `merge --ff-only` fails — sync only `ui.warn(...)`s and then rebases the
  stack onto the **stale/diverged local `main`**. Exit code `0`, prints `✓ Synced`.
  The branches do **not** descend from `origin/main`, are missing the merged trunk
  content, and the local-only trunk commits get dragged into the stack — while the
  PRs were already retargeted to `main` on GitHub. The user is told it worked.
- **Half-sync crash (worktrees).** Run from a linked worktree where `main` is
  checked out in the primary worktree, `git checkout main` is fatal →
  `Failed to checkout trunk "main"` → exit `2` — but only **after** the merged
  branch was deleted (remote + state) and PRs retargeted. The remaining branch is
  neither rebased nor marked resumable (`restackState` is null), so `st continue`
  can't help. `st` explicitly supports worktrees (0.9.9), so this is a core path.

This is the maintainer's report: "sync now pulls from main and rebases trunk but
doesn't [actually] update the rest of the stack onto the merge."

The fix's key observation: `origin/<trunk>` is freshly fetched (`sync.ts:53`),
immutable, and already the source of truth used by the `trunkMoved` gate
(`sync.ts:58-64`) — yet the rebase targets the mutable local branch instead. An
internal inconsistency.

## Root cause (HEAD = v0.9.10)

`src/commands/sync.ts` step 6:
- `:236-247` — `git checkout <trunk>` (fatal on failure → `return 2`) +
  `git merge --ff-only origin/<trunk>` (best-effort; failure only warns).
- `:268-273` — `rebaseBranch({ parentRef: stack.trunk, ... })` for the bottom
  branch → `src/lib/rebase.ts:43` → `git rebaseOnto(parentRef, ...)` →
  `src/lib/git.ts:95-102` runs `git rebase --onto <stack.trunk> --empty=drop ...`.
  `--onto main` resolves to the stale/diverged **local** commit.

## Design

Rebase onto the remote-tracking ref; demote the local-branch update to a
non-blocking cosmetic convenience.

1. **`src/lib/git.ts`** — add `fastForwardLocalBranch(branch, target)`: best-effort,
   non-fatal advance of a local branch ref to `target` **without checking it out**.
   No-op if `target` is unresolved, already equal, not a strict descendant of the
   branch (never rewind/clobber a diverged local trunk), or the branch is checked
   out somewhere (`git branch -f` refuses → safe). Creates the branch at `target`
   if absent. Works from a linked worktree.

2. **`src/commands/sync.ts`** — replace the checkout + `merge --ff-only` block:
   ```ts
   const trunkRef = git.hasRemoteRef(stack.trunk)
     ? `origin/${stack.trunk}`
     : stack.trunk;
   if (trunkRef !== stack.trunk) git.fastForwardLocalBranch(stack.trunk, trunkRef);
   ```
   Pass `parentRef: trunkRef` to the bottom-branch `rebaseBranch` call. `cascadeRebase`
   is unchanged: it rebases index ≥ 1 onto sibling branches (`parentBranch.name`),
   never the trunk, and `startIndex` is always `1` here.

No change to the conflict/resume protocol. On conflict the in-progress git rebase
already has `--onto origin/<trunk>` baked in, so `st continue` finishes it against
the correct base; `rebaseOnto` still returns `{ok:false, conflicts}`, sync still
sets `restackState` (`:278-283`) and returns 1. `--empty=drop` still drops the
squashed commit.

## Files

| File | Change |
|------|--------|
| `src/lib/git.ts` | add `fastForwardLocalBranch()` |
| `src/commands/sync.ts` | rebase onto `origin/<trunk>`; non-fatal local FF; drop fatal checkout |
| `package.json` | 0.9.10 → 0.9.11 |
| `CHANGELOG.md` | 0.9.11 entry |

No command surface / flag / `st status --json` change → shipped skills untouched.

## Verification (simulated; `/tmp/repro/clean.sh` + `de.sh`)

Isolated `HOME`, local bare `origin`, fake `gh` shim, forced `main`:

| Scn | Setup | Before | After fix |
|---|---|---|---|
| A | bottom PR squash-merged, local main stale | PASS | PASS |
| B | trunk advanced (unrelated), no merges | PASS | PASS |
| C | trunk advanced + bottom merged | PASS | PASS |
| D | local main **diverged** + bottom merged | **FAIL** (rebased on stale local main, exit 0) | **PASS** (rebased on origin/main) |
| E | run from linked worktree (main checked out elsewhere) | **FAIL** (exit 2, half-synced) | **PASS** (no checkout, rebases via remote ref) |

Plus: `bun tsc` clean.
