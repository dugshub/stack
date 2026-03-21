# Spec: Restore original branch after cascading restack

## Problem

When `st restack` cascades into dependent stacks, it leaves the user on the final branch of the last dependent stack instead of the branch they were on when they initiated the restack. This is disorienting.

**Root cause:** `restack.ts` captures `originalBranch` and restores it after the primary stack restack (line 133), but then `cascadeDependentStacks()` performs rebases that move HEAD. No checkout back to `originalBranch` happens after the cascade.

Same issue exists in `continue.ts` — no original branch tracking at all.

## Fix

### `src/commands/restack.ts`

Move the `git.checkout(originalBranch)` call to AFTER `cascadeDependentStacks` completes (or keep both — one before the cascade for the non-dependent case, and one after for safety).

Simplest approach: add `git.checkout(originalBranch)` after line 139 (after `cascadeDependentStacks` returns), inside the `if (cascadeResult.ok)` block.

### `src/commands/continue.ts`

1. Capture `originalBranch` at the top of `execute()`
2. After `cascadeDependentStacks` completes (line 124), checkout `originalBranch`

## Scope

- Two files: `restack.ts`, `continue.ts`
- Minimal change: add one `git.checkout()` call in each file after dependent stack cascade

## Edge cases

- If original branch was deleted during restack (shouldn't happen) — `git.checkout` would fail. Not a realistic concern since restack doesn't delete branches.
- Conflict during dependent cascade: the function returns early, user is left on the conflict branch. This is correct behavior — they need to resolve conflicts there. `st continue` will then restore them after completion.
