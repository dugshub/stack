# `st continue` crashes on the final branch-restore (detached HEAD)

## Problem

After `st sync` (or `st restack`) pauses on a rebase conflict, the user resolves
the conflict, stages, and runs `st continue`. The rebase **completes correctly**
— branches end up properly restacked — but `st continue` then dies with:

```
✓ Rebased feat-1
✓ Restacked remaining branches in "feat"
Internal Error: git checkout  failed (exit 128): fatal: empty string is not a
valid pathspec. please use . instead if you meant to match all paths
    at run (src/lib/git.ts:31:15)
    at checkout (src/lib/git.ts:190:3)
    at execute (src/commands/continue.ts:230:8)
```

Exit code is **1**, and the scary "Internal Error" stack trace makes it look like
the resume failed. To the user, "`st continue` on top of a paused sync doesn't
properly resume."

### Root cause (confirmed by reproduction)

`src/commands/continue.ts:21` captures the return target at the very top:

```ts
const originalBranch = git.currentBranch();   // = git branch --show-current
```

But `st continue` is, by definition, invoked **while a rebase is still paused**
(conflict resolved, rebase not yet finished). During a paused rebase, HEAD is
detached, so `git branch --show-current` returns the **empty string**. Thus
`originalBranch === ''`.

At the end of the happy path, `continue.ts:230` runs unconditionally inside
`if (cascadeResult.ok)`:

```ts
git.checkout(originalBranch);   // git checkout ""  → throws, exit 128
```

`git.checkout` uses `git.run` (throws on non-zero), so the empty pathspec error
propagates as an uncaught "Internal Error" and exit 1.

### Why this surfaced now / scope

This is a **pre-existing latent bug**, introduced 10 weeks ago in commit
`e00809a` ("fix: restore original branch after cascading dependent stack
restack"), which added both the `originalBranch` capture (line 21) and the
unguarded checkout (line 230). It affects **every** linear-rebase
conflict-resume — `restack` and `sync` alike — not just the new trunk-advance
sync path. The 0.9.8 `st sync` rebase feature simply gave users a fresh, common
way to hit a conflict that routes through `st continue`, exposing the bug.

The **join-branch (diamond) path** already wraps its restore in `try/catch`
(`continue.ts:151–155`), so it merely fails silently to restore rather than
crashing — but it shares the same root flaw (`originalBranch` is `''`), so it
also fails to return the user anywhere sensible.

### Reproduction (verified)

A scratch repo with trunk `dev`, one feature branch `feat-1` that conflicts with
an advanced trunk:

1. `st sync` → "Conflict rebasing feat-1 onto dev", sets `restackState`, exit 1.
2. Resolve `file.txt`, `git add file.txt`.
3. `st continue` →
   - `✓ Rebased feat-1` / `✓ Restacked remaining branches` (rebase is correct —
     `feat-1` sits on advanced `dev`, conflict resolved, `restackState` cleared,
     HEAD reattached to `feat-1`),
   - then crashes on `git checkout ""`, exit 1.

So the data outcome is already correct; only the final cosmetic "go home" step
crashes and poisons the exit code.

## Scope

**In:**
- Fix `st continue` so it never calls `git checkout ""`.
- Pick a sensible return branch when HEAD is detached at invocation (the normal
  case): the branch whose conflict was just resolved / the stack we resumed.
- Make the restore non-fatal (a failed `checkout` must never turn a successful
  resume into exit 1).
- Apply the same robustness to both the linear path (line ~230) and the
  join-branch path (line ~151–155) so they behave consistently.

**Out:**
- No change to the rebase/cascade logic itself — it already produces correct
  results. This is purely about the post-success branch restore + exit code.
- No change to `st sync`, `st restack`, `st abort`, or `restackState` shape.
- No attempt to recover the user's *pre-sync* branch (the branch they were on
  before `sync`/`restack` started in a separate process). That value is not
  available to `continue` and is out of scope; returning to the resumed stack
  branch is the correct, intuitive home.

## Current behavior (reference)

`src/commands/continue.ts`:
- **Line 21:** `const originalBranch = git.currentBranch();` — captured before
  state load; returns `''` because HEAD is detached during the paused rebase.
- **Lines 151–155** (join-branch success): `try { git.checkout(originalBranch); } catch {}`
  — does not crash, but `originalBranch` is `''` so it never actually returns home.
- **Line 230** (linear success): `git.checkout(originalBranch);` — **unguarded**,
  throws on `''`, producing the Internal Error + exit 1.

`git.currentBranch()` (`src/lib/git.ts:42`) is `git branch --show-current`, which
is empty under a detached HEAD / in-progress rebase.

## Design

The fix is small and local to `continue.ts`. Two pieces: (1) compute a valid
return target even when HEAD is detached, and (2) make the restore non-fatal.

### 1. Resolve a safe return branch

`originalBranch` is only meaningful when continue is run *after* the rebase
already finished externally (HEAD reattached). In the normal mid-rebase case it
is `''`. So fall back to the branch we just resumed.

The branch being resumed is already known inside `execute()`:
- Linear path: `stack.branches[restackState.currentIndex]` (the branch whose
  conflict we just resolved). After `currentIndex` is incremented at line 210,
  use `stack.branches[restackState.currentIndex - 1]`, or capture the name into
  a local (`currentBranch.name`) before incrementing.
- Join path: `js.branchName` (the join branch).

Introduce a single helper local to the file:

```ts
function safeReturn(originalBranch: string, fallback: string | undefined): void {
  const target = originalBranch || fallback;
  if (!target) return;
  git.tryRun('checkout', target);   // non-fatal: never throw
}
```

(Using `git.tryRun` instead of `git.checkout` guarantees the restore can never
crash a successful resume.)

### 2. Apply at both success sites

- **Linear path (line ~230):** replace `git.checkout(originalBranch);` with
  `safeReturn(originalBranch, currentBranch.name);`. `currentBranch` is in scope
  (line 161) and is the branch whose conflict was just resolved.
- **Join path (lines ~151–155):** replace the bare
  `try { git.checkout(originalBranch); } catch {}` with
  `safeReturn(originalBranch, joinBranch.name);` for consistency (and so the
  diamond case actually returns somewhere sensible instead of silently doing
  nothing).

### Why fall back to the resumed branch (not the stack bottom/top)

When a user resolves a conflict on branch N and runs `st continue`, leaving them
checked out on branch N (the thing they were just working on) is the least
surprising outcome. Dependent-stack cascades (`cascadeDependentStacks`) may move
HEAD onto dependent branches; the e00809a fix's intent — undo that movement —
is preserved, we just give it a valid target.

## Files

- `src/commands/continue.ts` — add `safeReturn` helper; use it at the linear and
  join success sites; the line-21 `originalBranch` capture stays (it's still the
  right value when the rebase was completed externally).

## Testing / verification

No automated test suite exists (per `CLAUDE.md`). Verify by reproduction:

1. Rebuild the scratch repo (trunk `dev`, conflicting `feat-1`, advanced trunk),
   hand-write `~/.claude/stacks/st-repro.json` with `parentTip` = original base.
2. `bun run src/cli.ts sync` → conflict, exit 1, `restackState` set.
3. Resolve `file.txt`, `git add file.txt`.
4. `bun run src/cli.ts continue` → **expect:** `✓ Rebased feat-1`,
   `✓ Restacked remaining branches`, **no Internal Error**, **exit 0**, and HEAD
   on `feat-1`.
5. Regression: a multi-branch stack conflict + `st continue` still cascades and
   ends on a real branch.

Also confirm `bun run src/cli.ts --help` / type-check (`bunx tsc --noEmit` if
configured) is clean.

## Versioning / skill

- Bug-only fix. Per `CLAUDE.md` versioning rules, bug-only fixes may skip a
  version bump; bump patch (0.9.9 → 0.9.10) + add a `CHANGELOG.md` line if we
  want it surfaced on `st update` (recommended — this is a user-facing crash).
- No command surface change → **no skill update required**.
```
