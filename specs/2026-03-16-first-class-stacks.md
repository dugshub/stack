# First-Class Stack Navigation

**Date:** 2026-03-16
**Status:** Ready

## Problem

The CLI is branch-centric. Every command resolves context by checking which stack the currently checked-out branch belongs to. This means you can't see your stacks, switch between them, or operate on one without first doing a `git checkout` to a branch that happens to be in it.

## Domain Model

Two-level hierarchy:

**Level 1: Stacks** — the thing you're working on (a feature, a refactor)
**Level 2: Branches** — the individual PRs within a stack

The CLI grammar reflects this:

```
stack                              # see all stacks (dashboard)
stack <name>                       # select/switch to a stack
stack <number>                     # jump to branch N in current stack
stack <command> [--stack,-s name]  # operate within a stack
```

Names are stacks. Numbers are branches. No args is the dashboard.

## Current Stack — Hybrid Resolution

A new `currentStack` field on `StackFile` (per-repo state) provides persistent stack context. Resolution order in `resolveStack()`:

```
1. Explicit --stack/-s flag          → use that stack (do NOT update currentStack)
2. Current branch in a stack         → use that stack, auto-update currentStack
3. Persisted currentStack            → use that (staleness-guarded)
4. Single-stack fallback             → use that stack
5. Interactive picker (TTY)          → use selected, set currentStack
6. Error                             → "No stack selected. Run stack <name> to select one."
```

**Important:** Step 1 (explicit flag) does NOT update `currentStack`. Using `--stack` is a one-shot override, not a context switch. Only steps 2 and 5 auto-update it.

**Mapping to existing code:** The current `resolve.ts` has 5 steps: (1) explicit name, (2) branch, (3) single-stack, (4) interactive, (5) error. The new ordering inserts `currentStack` as step 3 and pushes single-stack to step 4. The existing step 3 (single-stack fallback) becomes step 4 in the new sequence.

**Branch wins:** If you checkout a branch that belongs to stack X, `currentStack` auto-updates to X. This means `git checkout` and `stack nav` both implicitly select the stack.

**Persisted fallback:** If you're on `main` or a non-stack branch, `currentStack` remembers your last stack. `stack submit` on main works — targets the remembered stack.

**Staleness guard:** If `currentStack` points to a deleted stack, clear it and fall through to step 4.

### State Change

```ts
export interface StackFile {
  repo: string;
  stacks: Record<string, Stack>;
  currentStack: string | null;  // NEW — persisted selected stack
}
```

### Where currentStack Gets Set

- `stack <name>` (DefaultCommand) → sets currentStack
- `resolveStack()` step 2 (branch detection) → auto-updates currentStack
- `resolveStack()` step 5 (interactive picker) → sets currentStack
- `stack create` (all three modes: explicit, autoDetect, retroactive) → sets currentStack

### Where currentStack Gets Cleared

- `stack delete` → clears currentStack if it was the deleted stack
- `stack sync` → clears currentStack if stack was fully merged and removed
- `stack remove` → clears currentStack if removing the last branch deletes the stack
- `stack merge` → `cleanupLocal()` clears currentStack if stack was removed after full merge
- `resolveStack()` step 3 staleness guard → clears if stack no longer exists

## Design

### 1. Bare `stack` → Stacks Dashboard

If stacks exist, show a dashboard. If no stacks, show help. Requires a git repo (add to the `needsRepo`-equivalent check for the bare command path).

```
$ stack

  stack v0.1.0
  Stacked PRs for GitHub

  frozen-column   3 branches   updated 2h ago
▸ auth-refactor   2 branches   updated 1d ago
  perf-fixes      1 branch     updated 5m ago

  stack <name> to switch   stack create <name> to start
```

`▸` indicates the resolved current stack (branch detection first, then persisted `currentStack`). The marker shows which stack the CLI would target if you ran a command right now.

Implementation: rework the `args.length === 0` block in `cli.ts`. Add a repo check (currently bare `stack` skips the git check). Load state, resolve current stack for the indicator, render. `stack --help` still shows full command reference.

### 2. `stack <name>` → Select Stack

Register a `DefaultCommand` with `static paths = [Command.Default]` in clipanion. Catches any arg that doesn't match a registered command.

```ts
export class DefaultCommand extends Command {
  static override paths = [Command.Default];
  name = Option.String({ required: false });

  async execute(): Promise<number> {
    if (!this.name) return showDashboard();

    const state = loadAndRefreshState();
    const stack = state.stacks[this.name];
    if (!stack) {
      ui.error(`Unknown command or stack "${this.name}".`);
      return 2;
    }

    // Skip checkout if already on a branch in this stack
    const position = findActiveStack(state);
    if (position && position.stackName === this.name) {
      state.currentStack = this.name;
      saveState(state);
      ui.info(`Already on stack ${theme.stack(this.name)}`);
      ui.positionReport(position);
      return 0;
    }

    if (git.isDirty()) {
      ui.error('Working tree is dirty. Commit or stash before switching.');
      return 2;
    }

    const target = stack.branches[0];
    if (!target) { ui.error('Stack has no branches.'); return 2; }

    git.checkout(target.name);
    state.currentStack = this.name;
    saveState(state);

    ui.success(`Switched to stack ${theme.stack(this.name)}`);
    ui.positionReport({
      stackName: this.name, index: 0, total: stack.branches.length,
      branch: target, isTop: stack.branches.length === 1, isBottom: true,
    });
    return 0;
  }
}
```

**Routing order (safe):**
1. `stack <number>` → rewritten to `['nav', N]` before `cli.run()` (existing)
2. `stack <command>` → matched by clipanion command registry
3. `stack <anything-else>` → `DefaultCommand` → stack name lookup

**Dirty tree guard:** Check `git.isDirty()` before checkout. Skip entirely if already on a branch in the target stack.

**Bottom branch, not last-visited:** Always checks out index 0. Keeps state simple. User can `stack 3` after switching.

### 3. Stack Name / Command Name Collision

Reserved names added to `validateStackName()` in `src/lib/branch.ts`:

```
absorb, create, delete, help, init, merge, nav, push, remove,
restack, split, status, submit, sync, undo, update, version
```

Existing stacks with colliding names (unlikely): still reachable via `--stack,-s`. No migration needed.

### 4. Migrate All Commands to `resolveStack()`

The updated `resolveStack()` (with currentStack fallback) becomes the single resolution path. Every command uses it.

#### Already migrated (no work):
- `status`, `submit`, `delete`, `absorb`, `sync`

#### Commands to migrate:

**`nav`** — Add `--stack,-s`. When position is null (resolved via currentStack, not branch), synthesize a position at index 0. Track whether position was synthesized with a `positionWasSynthesized` boolean:

```ts
const positionWasSynthesized = position === null;
const effectivePosition: StackPosition = position ?? {
  stackName: resolvedName,
  index: 0,
  total: stack.branches.length,
  branch: stack.branches[0]!,
  isTop: stack.branches.length === 1,
  isBottom: true,
};
```

The `interactive()` method (line 217 of nav.ts) has its own `findActiveStack()` — migrate this too. Use `stack.branches[0]?.name` as `initialValue` when `positionWasSynthesized`. Skip "already on this branch" check when `positionWasSynthesized` (the synthesized branch isn't actually checked out).

**`restack`** — Add `--stack,-s`. `doRestack()` becomes async (because it now calls async `resolveStack()` for interactive picker support). When position is null: `fromIndex: -1`, `currentIndex: 0` — restack all from bottom. Matches `SyncCommand`'s existing pattern. `git.isDirty()` guard still applies. `--continue` and `--abort` already search all stacks — no change.

**`remove`** — Add `--stack,-s`. When position is null and no `branchArg`: error "Specify which branch to remove." Skip checkout-away logic when target !== current branch. **Also:** when removing the last branch deletes the stack, clear `currentStack` if it matches.

**`merge`** — Add `--stack,-s`. Migrate both `execute()` AND `showStatus()` (line 129 has its own `findActiveStack()`). Change `showStatus()` to accept `stackName` param for `findActiveJobForStack()`. **Also:** `cleanupLocal()` removes the stack — clear `currentStack` if it matches.

**`push`** — Excluded. Inherently about adding the *current branch*. Already has `--stack,-s`.

### 5. `resolveStack()` Picker Hint

Pre-existing issue now more visible: the interactive picker shows raw ISO timestamps in hints. Update to use `formatRelativeTime()`.

## Implementation Steps

### Step 1: State — add `currentStack` field
- Add `currentStack: string | null` to `StackFile` in `src/lib/types.ts`
- Update `loadState()` default return to include `currentStack: null`
- No migration needed — missing field reads as `undefined`, treated as `null`

### Step 2: Extract `formatRelativeTime` to shared utility
- Move from `status.ts` to new `src/lib/format.ts`
- Update `status.ts` to import from `format.ts`
- Verify `status.ts` still works after import change

### Step 3: Update `resolveStack()` — hybrid resolution
- In step 2 (branch detection): auto-update `state.currentStack` and `saveState()`. Do NOT do this in step 1 (explicit flag).
- Insert new step 3: if `state.currentStack` is set and the stack exists, use it with `position: null`. If it doesn't exist (stale), clear `currentStack` and fall through.
- Existing step 3 (single-stack fallback) becomes step 4.
- After step 5 (interactive picker): set `state.currentStack` and `saveState()`
- Update picker hint to use `formatRelativeTime()`
- Update error message (step 6) to: "No stack selected. Run `stack <name>` to select one."

### Step 4: Dashboard — rework bare `stack` in `cli.ts`
- Add git repo check to the `args.length === 0` path (currently skips repo check — dashboard needs it to load state)
- In `args.length === 0` block: load state, render dashboard if stacks exist
- Resolve current stack for `▸` indicator: try `findActiveStack()` first, then `state.currentStack`
- Show nav hints at bottom
- Extract render function for reuse by DefaultCommand fallback
- No stacks (or not in a git repo) → show existing help text

### Step 5: `DefaultCommand` — stack switching
- Create `src/commands/default.ts`
- `static paths = [Command.Default]`
- One positional string arg
- If already on a branch in the target stack: just set `currentStack`, skip checkout
- Otherwise: dirty check → checkout bottom branch → set currentStack → save
- Not found → error with suggestion
- Register in `cli.ts`

### Step 6: Reserved name validation
- Add `RESERVED_NAMES` set to `src/lib/branch.ts`
- Check in `validateStackName()` — return `{ valid: false, error: '"<name>" is reserved (conflicts with a command)' }`

### Step 7: Update `CreateCommand` to set currentStack
- Set `state.currentStack = name` in ALL THREE modes: `explicit()`, `autoDetect()`, `retroactive()`
- Save state after setting

### Step 8: Update `DeleteCommand` to clear currentStack
- If `state.currentStack === stackName`, set `state.currentStack = null`

### Step 9: Update `SyncCommand` to clear currentStack
- When stack is fully merged and removed (line 184), clear if `state.currentStack === resolvedName`

### Step 10: Migrate `NavCommand`
- Add `stackName = Option.String('--stack,-s', ...)`
- In `execute()`: replace `findActiveStack()` with `resolveStack()`, synthesize position, track `positionWasSynthesized`
- In `interactive()`: replace its own `findActiveStack()` (line 217) with `resolveStack()`. Use `positionWasSynthesized` to guard `initialValue` and "already on this branch" check
- Private directional methods unchanged (they receive synthesized position)

### Step 11: Migrate `RestackCommand`
- Add `stackName = Option.String('--stack,-s', ...)`
- Make `doRestack()` async (needs `resolveStack()` which is async for interactive picker)
- Handle null position: `fromIndex: -1`, `currentIndex: 0`
- `doContinue()` and `doAbort()` unchanged

### Step 12: Migrate `RemoveCommand`
- Add `stackName = Option.String('--stack,-s', ...)`
- Use `resolveStack()`
- Error when position is null and no `branchArg`
- Skip checkout-away when target !== current branch
- When last-branch removal deletes the stack: clear `currentStack` if it matches

### Step 13: Migrate `MergeCommand`
- Add `stackName = Option.String('--stack,-s', ...)`
- Migrate `execute()` to use `resolveStack()`
- Migrate `showStatus()` — accept `stackName` param, use for `findActiveJobForStack()`
- `cleanupLocal()` — clear `currentStack` if removed stack matches

### Step 14: Update help text
- Dashboard nav hints
- `stack --help` still shows full reference

## Non-Goals
- Global current stack (it's per-repo via `~/.claude/stacks/<repo>.json`)
- Persistent "last visited branch per stack"
- Worktree-per-stack
- Migrating `push` (inherently branch-centric)
- `stack <name> <N>` compound switching

## Risks
- **DefaultCommand + clipanion:** `Command.Default` is clipanion's supported catch-all. Confirmed in source: `isExclusivelyDefault` handles `paths.length === 0 || paths[0].length === 0`. Safe.
- **Auto-updating currentStack on branch detection** adds a `saveState()` to every command that resolves via branch. Atomic write via tmp+rename — fast, but worth noting.
- **Branch state after cross-stack operations:** `git rebase --onto` doesn't require checkout. `stack restack --stack other` from main should leave you on main. Verify during implementation.
