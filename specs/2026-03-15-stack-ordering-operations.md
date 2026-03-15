# Stack & Branch Ordering Operations

> Comprehensive plan for stack manipulation, branch reordering, splitting, merging, and topology operations.

## Status: DRAFT — Research + Planning (Validated 2026-03-15)

---

## Current State Analysis

### Data Model
```typescript
interface Stack {
  trunk: string;
  branches: Branch[];  // Flat ordered array — index IS position
  restackState: RestackState | null;
}
interface Branch { name: string; tip: string | null; pr: number | null; }
```

State is stored in `~/.claude/stacks/<repo>.json`. All ordering is implicit via array position.

### Existing Commands (13 registered + 1 unregistered)

| Command | Ordering relevance |
|---------|-------------------|
| `create` | Sets initial order via `--from` or single branch at position 0 |
| `push` | **Append-only** — adds to top of stack, enforces ancestry from top |
| `remove` | Splices branch out, retargets downstream PR base |
| `restack` | Cascading rebase from position N downward (conflict recovery) |
| `split` | **NOT REGISTERED** — splits uncommitted changes into new stack by file patterns |
| `nav` | Read-only position traversal |
| `submit` | Chains PR bases bottom-up from array order |
| `sync` | Removes merged branches, compacts array, rebases remaining |
| `absorb` | Routes fixes to owning branches — no order change |

### Key Architectural Constraints
1. **Branch naming embeds position**: `user/stack/N-description` — reordering makes N misleading
2. **`findActiveStack` assumes single membership**: returns first stack match for a branch
3. **Restack machinery is reusable**: `RestackState` + `cascadeRebase` handle conflict recovery
4. **All git ops are sync**: `Bun.spawnSync` everywhere except `pushParallel`
5. **Clipanion supports multi-segment paths**: `[['branch', 'insert']]` → `stack branch insert`

### Gaps
- No insert-at-position
- No move/swap within stack
- No stack splitting (at a position)
- No stack merging
- No stack forking/branching
- No branch transfer between stacks
- No rename

---

## Command Organization Decision

### Recommendation: Hybrid — Flat Primary + Grouped Advanced

Keep existing commands flat (they're muscle memory now). New ordering operations get namespaced under subcommands. This avoids breaking changes while scaling cleanly.

```
CORE (flat — unchanged)
  stack create          Start a new stack
  stack delete          Remove a stack from tracking
  stack status          Show stack and PR status
  stack push            Add current branch to top of stack
  stack remove          Remove a branch from the stack
  stack nav             Navigate between branches
  stack submit          Push branches, create/update PRs
  stack absorb          Route fixes to correct stack branches
  stack restack         Rebase downstream after mid-stack edits
  stack sync            Clean up after PRs merge
  stack split           Split uncommitted changes into branches (register existing!)

BRANCH OPERATIONS (new namespace)
  stack branch move     Move branch up/down within stack
  stack branch insert   Insert a new branch at any position
  stack branch adopt    Add an existing branch at a position
  stack branch eject    Remove branch, keep PR open → retarget to trunk
  stack branch transfer Move branch between stacks
  stack branch split    Split a single branch into multiple

STACK OPERATIONS (new namespace)
  stack edit split      Split a stack into two at a position
  stack edit merge      Combine two stacks
  stack edit fork       Fork stack into parallel stacks
  stack edit reorder    Freely reorder all branches
  stack edit rename     Rename a stack
```

**Why `stack edit` not `stack stack`?** `stack stack` is confusing. `edit` conveys mutation. Also considered `manage` but it's too long.

**Alternative**: just keep everything flat — `stack move`, `stack insert`, `stack merge-stacks`, etc. Simpler but namespace collision risk grows. **Let user decide.**

### File Organization

```
src/commands/
  branch/          ← new directory
    move.ts
    insert.ts
    adopt.ts
    eject.ts
    transfer.ts
    split.ts       ← different from top-level split (branch-level vs uncommitted changes)
  edit/            ← new directory
    split.ts
    merge.ts
    fork.ts
    reorder.ts
    rename.ts
```

---

## Phase 1: Foundation — Move, Insert, Reorder

**Goal**: Enable basic reordering within a single stack. These are the most requested operations and build the shared infrastructure for Phase 2+.

### Shared Infrastructure: `src/lib/restack.ts`

Extract restack logic from `RestackCommand` into a shared module. Every ordering operation needs cascading rebase.

```typescript
// src/lib/restack.ts
export function cascadeRestack(opts: {
  state: StackFile;
  stackName: string;
  fromIndex: number;
  oldTips: Record<string, string>;  // CRITICAL: caller must provide pre-mutation tips
  worktreeMap: Map<string, string>; // CRITICAL: must preserve worktree support
}): { ok: boolean; conflictIndex?: number };
```

This is a refactor of `RestackCommand.cascadeRebase()` into a standalone function that:
1. Uses **caller-provided** `oldTips` (NOT self-snapshotted — see critical note below)
2. Uses **caller-provided** `worktreeMap` for worktree-aware rebases
3. Sets `RestackState` on the stack
4. Iterates branches, rebasing each onto its parent
5. On conflict: saves state, returns `{ ok: false, conflictIndex }`
6. On success: clears `RestackState`, returns `{ ok: true }`

The existing `restack` command becomes a thin wrapper that snapshots tips itself before calling.

> **CRITICAL — `oldTips` seeding for reorder vs normal restack**:
>
> In normal `restack`, `oldTips` is seeded from current branch tips starting at `fromIndex`.
> This works because the array order hasn't changed — we're just rebasing downstream.
>
> For **move/reorder**, the array has been mutated BEFORE cascading. The `oldTips` must be
> snapshotted **before** the array mutation, and the mapping must reflect the pre-mutation
> ancestry chain. Example: swapping branches A(idx=1) and B(idx=2):
> - Pre-swap: A's parent is branch[0], B's parent is A
> - Post-swap array: [branch[0], B, A]
> - To rebase B (now at idx=1) onto branch[0]: oldTip for branch[0] is correct
> - To rebase A (now at idx=2) onto B: oldTip must be B's **original** tip (pre-swap)
>
> The caller is responsible for constructing the correct `oldTips` map for the new order.

> **Conflict continuation**: When any ordering command triggers `cascadeRestack` and hits
> a conflict, it sets `restackState` on the stack. The existing `stack restack --continue`
> and `--abort` handle ALL mid-cascade pauses regardless of which command initiated them.
> This is documented in help text: "Resolve conflicts, then run `stack restack --continue`."

### 1a. `stack branch move` — Move branch up/down

**UX**:
```bash
stack branch move up       # swap current branch with the one below (toward trunk)
stack branch move down     # swap current branch with the one above (away from trunk)
stack branch move 3        # move current branch to position 3
stack branch move --dry-run up  # show what would happen
```

**Algorithm**:
1. Validate: clean working tree, on a stack branch, no restack in progress
2. Compute new array order (swap or relocate)
3. `--dry-run`: show old → new order and exit
4. Update `stack.branches` array
5. Run `cascadeRestack` from the lowest affected index
6. Update PR bases via `gh pr edit --base` for affected branches
7. Save state

**Direction semantics**:
- `up` = toward trunk = lower array index (matches `nav up` convention)
- `down` = away from trunk = higher array index (matches `nav down` convention)

**Edge cases**:
- Moving bottom branch up → error "already at bottom of stack"
- Moving top branch down → error "already at top of stack"
- Moving to current position → no-op
- **Single-branch stack** → error "stack has only one branch — nothing to move"

**`oldTips` construction for swap**:
1. Snapshot ALL branch tips BEFORE mutating the array
2. Swap entries in the array
3. Build `oldTips` from the pre-mutation snapshot, keyed by branch name
4. Pass to `cascadeRestack` from the lower of the two swapped indices

**Complexity**: MEDIUM — array swap is trivial, restack is the hard part (but reusable)

### 1b. `stack branch insert` — Insert new branch at position

**UX**:
```bash
stack branch insert --after 2    # insert after position 2
stack branch insert --before 3   # insert before position 3 (same as --after 2)
stack branch insert --after 2 --description add-types  # specify branch description
stack branch insert --dry-run --after 2
```

**Algorithm**:
1. Validate: clean working tree, on a stack branch, no restack in progress
2. Resolve position (--after N or --before N)
3. Determine parent branch (the one at `position - 1`, or trunk for position 0)
4. **Snapshot `oldTips` for all branches from insertIndex onward BEFORE mutation**
5. Prompt for branch description if not given
6. Create new git branch from parent's tip (tip = parent's tip at this point)
7. `stack.branches.splice(insertIndex, 0, newBranch)` — newBranch.tip = parent's tip
8. Build `oldTips` map: for each downstream branch (insertIndex+1 onward), the oldTip for
   its new parent is the **parent's pre-insert tip** (which is the new branch's tip, since
   the new branch is empty and starts at parent's tip)
9. Run `cascadeRestack` from insertIndex + 1 with the prepared `oldTips`
10. Save state

**Note**: The new branch starts empty (same content as parent). If user runs `submit` before
adding commits, it creates a zero-diff PR — this is valid but the command should warn about it.
User then makes commits and restacks.

### 1c. `stack edit reorder` — Freely reorder all branches

**UX**:
```bash
stack edit reorder             # interactive: TUI drag/select to reorder
stack edit reorder 3 1 2 4     # explicit: specify new order by position numbers
stack edit reorder --dry-run 3 1 2 4
```

**Algorithm**:
1. Validate: clean working tree, on a stack branch, no restack in progress
2. If no args: interactive reorder using `@clack/prompts`
3. If args: parse position numbers, validate they're a valid permutation
4. `--dry-run`: show old → new order and exit
5. Reorder `stack.branches` array
6. Run `cascadeRestack` from position 0 (everything needs rebasing)
7. Update all PR bases
8. Save state

**Warning**: This WILL cause conflicts. The command should clearly warn the user.

### 1d. Register existing `split` command

Just add the import and registration in `cli.ts`. It's fully implemented.

### 1e. Help text update

Update the custom help output in `cli.ts` to show grouped commands:

```
STACK
  create [name]               Start a new stack
  delete [name]               Remove a stack from tracking
  status                      Show stack and PR status
  split                       Split uncommitted changes into branches

BRANCHES
  push                        Add current branch to the stack
  remove [branch]             Remove a branch from the stack
  nav [up|down|top|bottom]    Navigate between branches
  branch move [up|down|N]     Move a branch within the stack
  branch insert --after N     Insert a new branch at position

WORKFLOW
  submit                      Push branches, create/update PRs
  absorb                      Route fixes to correct stack branches
  restack                     Rebase downstream after mid-stack edits
  sync                        Clean up after PRs merge

ADVANCED
  edit reorder [positions]    Freely reorder branches in stack
```

---

## Phase 2: Cross-Stack Operations — Split, Merge, Transfer

**Goal**: Operations that create, combine, or move between stacks.

### 2a. `stack edit split` — Split stack into two

**UX**:
```bash
stack edit split              # split at current branch (current becomes top of stack 1)
stack edit split --at 3       # split after position 3
stack edit split --name new-feature  # name for the new stack
stack edit split --dry-run
```

**Algorithm**:
1. Validate: on a stack branch, no restack in progress
2. Resolve split position
3. Prompt for new stack name if not given
4. Create new stack with branches from `splitIndex + 1` onward
5. Truncate original stack's branches array at `splitIndex`
6. New stack's trunk = original stack's trunk (or the split branch itself — design decision)
7. Rebase new stack's first branch onto trunk
8. Update all PR bases in new stack
9. Save state

**Design decision — trunk of new stack**:
- **Option A**: Same trunk as original (branches are rebased onto trunk). Cleaner but loses dependency info.
- **Option B**: Split branch becomes the base. More accurate but the split branch can't merge independently without updating the new stack.
- **Recommendation**: Option A (same trunk). The split point was a dependency but after splitting, the stacks should be independent.

### 2b. `stack edit merge` — Combine two stacks

**UX**:
```bash
stack edit merge other-stack              # append other-stack's branches after current stack
stack edit merge other-stack --position 2 # insert at position 2
stack edit merge --dry-run other-stack
```

**Algorithm**:
1. Validate: on a stack branch, both stacks exist, no restack in progress in either
2. Rebase the other stack's bottom branch onto the insertion point branch
3. Splice other stack's branches into current stack at the specified position
4. Run `cascadeRestack` from insertion point
5. Update all PR bases
6. Delete the other stack from state
7. Save state

### 2c. `stack branch transfer` — Move branch between stacks

**UX**:
```bash
stack branch transfer --to other-stack           # move current branch to top of other-stack
stack branch transfer --to other-stack --at 2    # insert at position 2
stack branch transfer --dry-run --to other-stack
```

**Algorithm**:
1. Snapshot `oldTips` for BOTH stacks before any mutation
2. Remove branch from source stack (like `remove` but keep the branch and PR)
3. **Run `cascadeRestack` on source stack FIRST — complete fully before proceeding**
4. **Save state after source cascade completes** (checkpoint for conflict recovery)
5. Rebase branch onto target stack's insertion point
6. Insert into target stack's branches array
7. Run `cascadeRestack` on target stack
8. Update PR bases (both stacks, batched)
9. Save state

> **Sequential cascades are critical**: If source cascade conflicts, we stop and the user
> resolves via `restack --continue`. The target stack hasn't been touched yet. Only after
> source fully completes do we mutate the target. This avoids dual-restackState ambiguity.

### 2d. `stack branch adopt` — Add existing branch at position

**UX**:
```bash
stack branch adopt feature-branch --at 2    # insert existing branch at position 2
stack branch adopt feature-branch           # append to top (like push but position-aware)
stack branch adopt --dry-run feature-branch
```

**Algorithm**:
1. Validate: branch exists, not already in a stack
2. Look up existing PR for the branch
3. Rebase branch onto the parent at the specified position
4. Insert into branches array
5. Run `cascadeRestack` from insertion point
6. Save state

### 2e. `stack branch eject` — Remove but keep PR open

**UX**:
```bash
stack branch eject              # eject current branch
stack branch eject branch-name  # eject specific branch
```

**Algorithm**:
1. Remove from stack state (like `remove`)
2. Retarget PR base to trunk (not to the previous branch)
3. Do NOT close the PR or delete the branch
4. Run `cascadeRestack` on downstream branches (they skip the ejected branch)

### 2f. `stack edit rename` — Rename a stack

**UX**:
```bash
stack edit rename new-name
```

**Algorithm**:
1. Validate new name
2. `state.stacks[newName] = state.stacks[oldName]`
3. `delete state.stacks[oldName]`
4. Save state

**Note**: Does NOT rename git branches. The branch naming convention (`user/stack/N-desc`) embeds the stack name, so branches will have the old name. This is acceptable — branch names are opaque identifiers.

---

## Phase 3: Advanced — Fork, Branch Split

**Goal**: Topology operations that push the data model boundaries.

### 3a. `stack edit fork` — Fork stack at position

**UX**:
```bash
stack edit fork --name parallel-feature    # fork from current branch
stack edit fork --at 2 --name parallel     # fork from position 2
```

**Algorithm**:
1. The fork creates a NEW stack that starts fresh from the fork point
2. No shared branches (copy, don't share — avoids multi-membership complexity)
3. The new stack's trunk = the branch at the fork point in the original stack
4. User adds new branches to the forked stack normally

**Why copy-not-share**: `findActiveStack` assumes single membership. Shared branches would require:
- Changing `findActiveStack` to return all matches
- Adding stack disambiguation to every command
- Handling cascading updates across stacks

This is too disruptive. Instead, the fork is conceptual — "start a new stack that depends on branch X of stack Y."

**Data model addition**:
```typescript
interface Stack {
  // ... existing fields
  dependsOn?: { stack: string; branch: string };  // NEW: optional parent reference
}
```

When the parent stack's branch gets updated, `stack sync` can optionally rebase the forked stack.

### 3b. `stack branch split` — Split single branch into multiple

**UX**:
```bash
stack branch split "api:src/lib/*.ts" "server:src/server/**"  # split by file patterns
stack branch split --interactive                               # TUI file selector
stack branch split --dry-run "api:src/lib/*.ts"
```

**Algorithm**:
1. Get the diff between this branch and its parent
2. Parse file patterns (reuse `parseSplitArgs` from `src/lib/split.ts`)
3. For each pattern group:
   a. Create a new branch from the parent
   b. Cherry-pick or reconstruct only the matching changes
   c. Commit
4. Replace the original branch in the stack with the new branches
5. Run `cascadeRestack` on downstream branches
6. If original branch had a PR, close it (or reassign to first new branch)

**This is the hardest operation** because it requires decomposing committed changes, not just uncommitted ones. Two approaches:

- **Approach A — Reconstruct**: For each file group, create a new branch from parent, apply only those files from the original branch's diff. Like `split` command but for committed changes.
- **Approach B — Interactive rebase**: Use `git rebase -i` equivalent to split commits, then assign resulting commits to separate branches.

**Recommendation**: Approach A (reconstruct), reusing the file-content-snapshot pattern from `absorb` and `split`.

---

## Shared Patterns Across All Phases

### Pre-flight checks (every ordering command)
```typescript
function preflight(state, stack) {
  if (git.isDirty()) error('Working tree is dirty');
  if (stack.restackState) error('Restack in progress');
}
```

### Post-mutation pattern
```typescript
function postMutation(state, stack, stackName, fromIndex, oldTips) {
  const worktreeMap = git.worktreeList();
  cascadeRestack({ state, stackName, fromIndex, oldTips, worktreeMap });
  // Use GraphQL batch mutations (MutationBatch from graphql.ts) for PR base updates
  // NOT sequential gh.prEdit calls — match submit's batching pattern
  updatePRBasesBatch(state, stack);  // batch via MutationBatch
  // Also update stack navigation comments on all PRs
  updateStackComments(state, stack, stackName);
  stack.updated = new Date().toISOString();
  saveState(state);
}
```

> **PR updates must use GraphQL batching** (like `submit` does via `MutationBatch`) —
> not sequential `gh pr edit --base` calls. For a 10-branch reorder, batching is 1 API
> call vs 10 sequential CLI invocations. Stack navigation comments must also be updated.

### Dry-run pattern
Every command supports `--dry-run` that shows the planned state change without executing.

---

## Branch Naming Caveat

Branch names embed position: `user/stack/3-add-types`. After reordering, position 3 might be at array index 1. Options:

1. **Ignore it** — branch names are just identifiers, positions are cosmetic. The array index is truth. **(Recommended for now)**
2. **Rename branches on reorder** — `git branch -m` + update remote + update PR. Risky and complex.
3. **Stop embedding position** — change naming convention to `user/stack/add-types`. Breaking change for existing stacks.

Recommendation: Option 1 for Phase 1-2, revisit if users find it confusing.

---

## Implementation Order

### Phase 1 (Foundation)
1. Extract `src/lib/restack.ts` from `RestackCommand`
2. Register existing `split` command in `cli.ts`
3. `stack branch move` — simplest ordering operation
4. `stack branch insert` — most requested
5. `stack edit reorder` — generalization of move
6. Update help text

### Phase 2 (Cross-Stack)
7. `stack edit rename` — trivial, good warm-up
8. `stack branch eject` — enhanced remove
9. `stack branch adopt` — enhanced push
10. `stack edit split` — split stack at position
11. `stack edit merge` — combine stacks
12. `stack branch transfer` — move between stacks

### Phase 3 (Advanced)
13. `stack edit fork` — fork with `dependsOn` model
14. `stack branch split` — decompose committed changes
15. Cross-stack sync in `stack sync`

---

## Validator Findings (2026-03-15)

### Resolved in this revision
- `cascadeRestack` signature now includes `oldTips` and `worktreeMap` params
- `oldTips` seeding logic for move/reorder explicitly documented
- `branch insert` algorithm now snapshots tips before mutation
- `branch transfer` uses sequential cascades with checkpoint saves
- `branch move` direction semantics and single-branch edge case documented
- PR base updates now specify GraphQL batching (not sequential `gh pr edit`)
- Conflict continuation documented: `stack restack --continue` handles all origins

### Accepted simplifications
- **`eject` is thin over `remove`**: Consider adding `--retarget-trunk` flag to `remove` instead of a new command. Decision: keep as separate command for discoverability, but implementation can delegate to `remove` internals.
- **`adopt` overlaps with `push`**: Consider `push --at N` instead. Decision: `push --at N` is cleaner; `adopt` as an alias. Implement as `push` extension.
- **`edit rename` feels orphaned**: Move to flat `stack rename`. No structural mutation involved.
- **Phase 3 TUI for `reorder`**: Defer interactive mode. Ship positional-args only first.

### Naming concerns (NEEDS USER INPUT)
- `stack branch X` could confuse with `git branch`. Alternatives: `stack br move`, just flat `stack move`
- `stack edit X` is a weak verb for structural operations. Alternatives: flat names (`stack split-stack`, `stack merge-stacks`), or just `stack split --stack` (flag-based disambiguation)
- `stack split` (uncommitted changes) vs `stack branch split` (committed) — naming collision risk

---

## Risks & Open Questions

1. **Conflict storms**: Reordering almost always causes conflicts. Should we add a `--force` mode that drops conflicting branches and warns?
2. **PR comment updates**: Resolved — ordering commands update comments via GraphQL batch (same as submit).
3. **Remote state**: Reordering changes PR bases but doesn't push. Should ordering commands auto-submit?
4. **Undo**: Should we add `stack undo` that restores the previous state? The JSON state file could keep a `previousState` snapshot.
5. **Flat vs namespaced**: The spec proposes `stack branch move` and `stack edit split`. An alternative is staying flat: `stack move`, `stack split-stack`, etc. **Need user input.**
6. **Binary files and renames**: `branch split` (Phase 3) inherits the `split` command's limitation — binary files and renames may silently lose content during reconstruction.
7. **`dependsOn` back-references**: If Phase 3 `fork` adds `dependsOn`, then `rename` must update cross-references. Build rename before fork to avoid this.
