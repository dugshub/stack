# Stack Resolution: First-Class Stack Targeting

**Date:** 2026-03-15
**Status:** Draft
**Scope:** Stop-gap — stack-bench will introduce many-to-many stack↔branch relationships

## Problem

Every command resolves the target stack via `findActiveStack()`, which matches `git.currentBranch()` against branches in state. This means:

1. Stack-level operations (submit, sync, absorb) fail when not on a stack branch
2. There's no way to say "operate on stack X" from `main` or an unrelated branch
3. No interactive fallback when the user has stacks but isn't on one

## Design Principles

- **Stop-gap**: Keep changes minimal and forward-compatible with stack-bench's many-to-many model
- **No command taxonomy change**: Don't rename or namespace commands
- **Convention**: Stack is resolved, not configured — no persistent "current stack" state

## Solution: `resolveStack()` Helper

Replace ad-hoc `findActiveStack()` usage with a unified `resolveStack()` that tries strategies in order:

### Resolution Order

1. **Explicit flag** `--stack <name>` — if provided, use it directly (error if not found)
2. **Current branch** — today's `findActiveStack()` behavior
3. **Single-stack fallback** — if exactly one stack exists, use it silently
4. **Interactive picker** — if multiple stacks exist and we're in a TTY, prompt with `@clack/prompts select`
5. **Error** — centralized error message: `No stack found. Use --stack <name> or checkout a stack branch.`

Note: single-stack fallback comes before the interactive picker — if there's only one stack, don't prompt.

### API

```typescript
// src/lib/resolve.ts

interface ResolveOptions {
  state: StackFile;
  explicitName?: string;   // from --stack flag
  interactive?: boolean;    // default: process.stderr.isTTY
}

interface ResolvedStack {
  stackName: string;
  stack: Stack;
  position: StackPosition | null;  // null when not on a branch in this stack
}

function resolveStack(opts: ResolveOptions): ResolvedStack;
// Throws with centralized error message on failure — callers don't need their own error strings.
// Never returns null — either resolves or throws.
```

`position` being `null` is the key change — commands must handle "we know the stack but aren't on a branch in it." Stack-level commands (submit, sync) work fine with position=null. Branch-level commands (nav, remove) require position and should check it themselves.

### Edge Cases

- **Branch in multiple stacks (corrupted state):** Returns first match, same as today's `findActiveStack`. Document this. stack-bench will handle this properly with the picker.
- **Non-TTY with multiple stacks and no branch match:** Error, not picker. Scripts must use `--stack`.

## Changes Per Command

### Stack-Level Commands (add `--stack` flag + resolveStack)

| Command | Current | After |
|---------|---------|-------|
| **submit** | Must be on stack branch | `--stack <name>` or picker; works from anywhere |
| **sync** | Branch match → single-stack fallback → error | Uses `resolveStack()` — same behavior but adds picker for multi-stack |
| **absorb** | Must be on stack branch | `--stack <name>` or picker; works from anywhere. Note: absorb only needs `stackName`, not `position.index` — position=null is fine |
| **status** | Branch match → show-all fallback | `--stack <name>` for targeted detail view; no-arg keeps current dual-mode behavior |
| **delete** | Positional name arg → branch match → error | Migrate to `resolveStack()` with positional arg mapped to `explicitName`; adds picker |

### Branch-Level Commands (no change)

| Command | Why no change |
|---------|---------------|
| **nav** | Inherently requires being on a stack branch — no meaningful off-stack behavior |
| **remove** | Operates on current or named branch within current stack |

### Already Has `--stack` (keep as-is)

| Command | Notes |
|---------|-------|
| **push** | Already has `--stack,-s` and its own resolution with intentional "must specify --stack" error for multi-stack. Keep — push's "add branch to stack" semantics benefit from being explicit, not interactive |

### Already Stack-Agnostic (no change needed)

| Command | Why |
|---------|-----|
| **restack --continue/--abort** | Searches all stacks for `restackState` — already works without branch context |
| **restack (initial)** | Requires `position.index` to know where cascade starts — must be on a stack branch. Adding `--stack` without also adding `--from-branch` is misleading. Leave as-is. |
| **create** | Creates new stacks |
| **split** | Creates new stacks from dirty files |
| **undo** | Operates on state snapshots |
| **init** | Repo-level |
| **update** | System-level |

## Implementation Steps

### Step 1: Create `src/lib/resolve.ts`

- Implement `resolveStack()` with the resolution chain
- Reuse `findActiveStack` from state.ts internally
- Interactive picker uses `@clack/prompts` `select()` — already a dependency
- Centralized error message — callers don't craft their own

### Step 2: Add `--stack` Option to Target Commands

Add directly to each command (clipanion has no mixins):

```typescript
stackName = Option.String('--stack,-s', {
  description: 'Target stack by name',
});
```

### Step 3: Migrate Commands (one at a time)

Order: submit → sync → absorb → status → delete

For each:
1. Add `--stack,-s` option (skip for delete — keep positional arg, map to `explicitName`)
2. Replace `findActiveStack()` call with `resolveStack()`
3. Handle `position: null` case appropriately
4. Verify with `--dry-run` where available

### Step 4 (follow-up, not this PR): Scope Flags

Reserve for later:
- `--only` — submit just the current branch (needs thought on stale stack comments)
- `--upstack` / `--downstack` — directional scoping

## Forward Compatibility with stack-bench

stack-bench will introduce many-to-many relationships (a branch can be in multiple stacks). This spec is compatible:

- `resolveStack()` returns a single stack — in stack-bench, if a branch is in multiple stacks, the picker disambiguates
- `--stack <name>` is already explicit targeting — works unchanged
- `position` being nullable prepares commands for operating on stacks without branch context
- No state schema changes — resolution is purely a command-layer concern
- `ResolvedStack` is an internal type, not a public API — free to evolve

## Not In Scope

- Command namespacing (`stack stack ...` / `stack branch ...`)
- `--upstack` / `--downstack` / `--only` scope flags (follow-up)
- Persistent "current stack" config
- State schema changes
- Changes to push, restack, nav, or remove
