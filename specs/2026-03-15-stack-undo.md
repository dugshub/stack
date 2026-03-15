# stack undo — Snapshot-Based Undo System

**Status:** Ready for implementation
**Date:** 2026-03-15

## Overview

`stack undo` gives users a safety net for mutating commands. Before any command that modifies stack state runs, it appends a full snapshot of the current stacks to a JSONL history file. `stack undo` reads that history and resets git branches and state to match the snapshot. No push is performed — the user runs `stack submit` afterward to sync remote.

## Architecture

```
UndoCommand ──reads/writes──→ undo.ts (saveSnapshot / listSnapshots / restoreSnapshot)
                                    │
                                    ├──reads──→ state.ts (loadState / saveState / getStackDir)
                                    └──calls──→ git.ts (resetHard / branchCreate / isRebaseInProgress)

Every mutating command ──calls──→ saveSnapshot(commandName) at top of execute()
                                    │
                                    └──appends line to──→ ~/.claude/stacks/<repo>.history.jsonl
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/undo.ts` | create | History file management: saveSnapshot, listSnapshots, restoreSnapshot |
| `src/commands/undo.ts` | create | UndoCommand clipanion class |
| `src/cli.ts` | modify | Import + register UndoCommand; add to help text |
| `src/lib/state.ts` | modify | Add getHistoryFilePath() export |
| `src/lib/git.ts` | modify | Add resetHard() and branchCreate() helpers |
| `src/commands/submit.ts` | modify | Call saveSnapshot('submit') at top of fullSubmit() |
| `src/commands/sync.ts` | modify | Call saveSnapshot('sync') before git.fetch() |
| `src/commands/restack.ts` | modify | Call saveSnapshot('restack') at top of doRestack() |
| `src/commands/absorb.ts` | modify | Call saveSnapshot('absorb') after dry-run guard |
| `src/commands/remove.ts` | modify | Call saveSnapshot('remove') after restackState guard |
| `src/commands/delete.ts` | modify | Call saveSnapshot('delete') after confirmation |
| `src/commands/push.ts` | modify | Call saveSnapshot('push') before mutation |
| `src/commands/split.ts` | modify | Call saveSnapshot('split') at top of executePlan() |

## Interfaces

```typescript
// src/lib/undo.ts

interface UndoEntry {
  timestamp: string;              // ISO 8601
  command: string;                // "submit" | "sync" | "restack" | etc.
  stacks: Record<string, Stack>;  // deep copy of state.stacks at snapshot time
}

interface SnapshotSummary {
  index: number;       // 1 = most recent
  timestamp: string;
  command: string;
  stackCount: number;
  branchCount: number;
}

interface RestoreResult {
  branchesReset: string[];     // branches git reset --hard was called on
  branchesCreated: string[];   // branches recreated from SHA
  branchesOrphaned: string[];  // branches in current state not in snapshot (left alone)
  stacksRestored: number;
}
```

## Implementation

### 1. state.ts — Add getHistoryFilePath()

```typescript
export function getHistoryFilePath(): string {
  const repoName = git.repoBasename();
  return join(getStackDir(), `${repoName}.history.jsonl`);
}
```

### 2. git.ts — Add resetHard() and branchCreate()

```typescript
export function resetHard(branch: string, sha: string): void {
  run('checkout', branch);
  run('reset', '--hard', sha);
}

export function branchCreate(name: string, sha: string): boolean {
  return tryRun('branch', name, sha).ok;
}
```

### 3. src/lib/undo.ts

#### saveSnapshot(command: string): void

```
1. loadState() → get current stacks
2. If no stacks (empty): return (nothing to snapshot)
3. Build UndoEntry { timestamp, command, stacks: JSON.parse(JSON.stringify(state.stacks)) }
4. Read existing history file (catch ENOENT → empty)
5. Parse JSONL lines
6. Append new entry
7. If > 20 entries: keep last 20
8. Write atomically (tmp + rename, same pattern as saveState)
9. Errors swallowed silently — undo is best-effort
```

#### listSnapshots(): SnapshotSummary[]

```
1. Read history file (catch → return [])
2. Parse JSONL lines
3. Reverse so index 1 = most recent
4. Map to SnapshotSummary with computed stackCount/branchCount
```

#### restoreSnapshot(steps: number): RestoreResult

```
1. Read + parse all history entries
2. Validate entries.length >= steps, else throw
3. Target = entries[entries.length - steps]
4. If git.isRebaseInProgress(): git.tryRun('rebase', '--abort')
5. Record current branch for later (git.tryRun('branch', '--show-current'))
6. For each stack in target:
   For each branch:
     - If tip is null: skip
     - If branch exists in git: git.resetHard(branch.name, tip) → branchesReset
     - Else: git.branchCreate(branch.name, tip) → branchesCreated
   Set restackState = null
7. Collect branches in current state but NOT in snapshot → branchesOrphaned
8. Build new state: { repo: currentState.repo, stacks: deepCopy(target.stacks) }
   Clear all restackState fields
9. saveState(newState)
10. Truncate history: keep entries[0..length-steps) (remove target + everything after)
    Write atomically
11. Try to checkout original branch (best-effort)
12. Return RestoreResult
```

### 4. src/commands/undo.ts

```typescript
export class UndoCommand extends Command {
  static override paths = [['undo']];
  static override usage = Command.Usage({
    description: 'Restore stack state to before the last mutating command',
    examples: [
      ['Undo the last operation', 'stack undo'],
      ['Go back 3 operations', 'stack undo --steps 3'],
      ['List available restore points', 'stack undo --list'],
      ['Preview without applying', 'stack undo --dry-run'],
    ],
  });

  list = Option.Boolean('--list', false, { description: 'Show available restore points' });
  steps = Option.String('--steps', '1', { description: 'How many operations to undo' });
  dryRun = Option.Boolean('--dry-run', false, { description: 'Show what would change' });
}
```

execute() flow:
- `--list`: display table with index, relative time, command, stack/branch counts
- `--dry-run`: load target snapshot, diff against current state, display
- Default: call restoreSnapshot(), print results, suggest `stack submit`

### 5. cli.ts changes

- Import and register UndoCommand
- Add `['undo', 'Undo last mutating command']` to help text after `sync`

### 6. saveSnapshot placement in each command

| Command | Where | After which guard |
|---------|-------|-------------------|
| submit.ts | Top of `fullSubmit()` | After dry-run guard (execute returns early for dry-run) |
| sync.ts | Before `git.fetch()` (~line 72) | After dirty-tree + restackState guards |
| restack.ts | Top of `doRestack()` | After dirty-tree, position, isTop guards |
| absorb.ts | After dry-run guard (~line 138) | Before `const commitMsg = ...` |
| remove.ts | After restackState guard (~line 55) | Before targetName resolution |
| delete.ts | After confirmation prompt | Before PR close / branch delete blocks |
| push.ts | Before `stack.branches.push()` | After all validation |
| split.ts | Top of `executePlan()` | Before allDirtyFiles() |

## Testing

No test suite — verify manually:

1. Run a mutating command → check `.history.jsonl` has a new line
2. `stack undo --list` → displays entries
3. `stack undo --dry-run` → shows diff, no changes
4. `stack undo` → branches reset to previous tips (verify with `git log --oneline -1`)
5. `stack undo --steps 2` → goes back two ops
6. After `stack sync` deletes branches → `stack undo` recreates them
7. During rebase conflict → `stack undo` aborts rebase and restores
8. Run 25 commands → history file has exactly 20 lines
