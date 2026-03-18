# Stack Move, Insert, Reorder

> Reorder branches within a stack: swap positions, insert new branches mid-stack, or freely permute.

## Status: DRAFT (Validated 2026-03-18)

---

## Commands

### `stack move up|down|N`

Move the current branch within the stack.

```bash
stack move up       # swap with branch below (toward trunk)
stack move down     # swap with branch above (away from trunk)
stack move 3        # move current branch to position 3
stack move --dry-run up
```

**Direction semantics** (matches `stack nav`): `up` = toward trunk = lower index, `down` = away from trunk = higher index.

**Algorithm:**
1. Resolve stack + position via `resolveStack()`
2. Validate: clean tree, no restack in progress, not a single-branch stack
3. Compute target index from direction/number
4. Boundary check: error if already at edge
5. `--dry-run`: show old → new order, exit
6. `saveSnapshot('move')`
7. **Build `oldTips`** from current branch tips BEFORE any mutation
8. Splice current branch out, splice into target index
9. Update PR bases for all affected branches via `gh.prEdit(pr, { base })`
10. Auto-rebase via `cascadeRebase` from the lower of the two positions (pass pre-mutation `oldTips`)
11. Save state

**Edge cases:**
- `move up` at bottom → error "already at bottom"
- `move down` at top → error "already at top"
- `move N` to current position → no-op with info message
- Single-branch stack → error "nothing to move"

### `stack insert --after N`

Insert a new empty branch at a position in the stack.

```bash
stack insert --after 2                          # insert after position 2
stack insert --after 2 -d add-types             # specify description
stack insert --before 3                         # same as --after 2
stack insert --dry-run --after 2
```

**Algorithm:**
1. Resolve stack via `resolveStack()`
2. Validate: clean tree, no restack in progress
3. Resolve position (`--after N` or `--before N`, 1-indexed user-facing). `--before 1` means insert at the bottom (new position 0, before entire stack).
4. Prompt for description if not given (or require in non-interactive mode)
5. `--dry-run`: show where new branch will be inserted, exit
6. `saveSnapshot('insert')`
7. **Build `oldTips`** from current branch tips BEFORE any mutation
8. Determine parent: branch at `insertIndex - 1`, or trunk for index 0
9. Build branch name: `buildBranchName(user, stackName, insertIndex + 1, description)`
10. Create branch: `git.branchCreate(name, parentTip)` + `git.checkout(name)`
11. Splice into `stack.branches` at `insertIndex`
12. Update PR bases for downstream branches
13. Auto-rebase via `cascadeRebase` from `insertIndex + 1` (pass pre-mutation `oldTips`). If inserting at top, this is a no-op (no downstream branches).
14. Save state

**Notes:**
- The new branch starts empty (same content as parent). The command warns about this.
- Branch name numbers are cosmetic and won't be updated for existing branches. After insert, numeric prefixes in branch names may not match array positions. The array index is the source of truth.

### `stack reorder 3 1 2 4`

Freely permute all branches in the stack.

```bash
stack reorder 3 1 2 4           # new order by 1-indexed position numbers
stack reorder --dry-run 3 1 2 4
```

**Algorithm:**
1. Resolve stack via `resolveStack()`
2. Validate: clean tree, no restack in progress
3. Parse position numbers (1-indexed), validate they're a complete permutation (all positions present, no duplicates)
4. `--dry-run`: show old → new order, exit
5. `saveSnapshot('reorder')`
6. Reorder `stack.branches` array per the permutation
7. **Do NOT update PR bases.** Do NOT auto-rebase.
8. Print warning: `"Branches reordered. Run 'stack restack' to rebase, then 'stack submit' to update PRs."`
9. Save state

**Why no auto-rebase or PR update for reorder:** A full reorder touches every branch and will almost certainly cause conflicts. Updating PR bases before restack would show misleading diffs on GitHub (branches haven't been rebased onto their new parents yet). Instead: reorder the array, let the user `restack` when ready (with `--abort` as escape hatch), then `submit` to push + update PR bases in one shot. `move` and `insert` auto-rebase because they affect fewer branches.

---

## Shared patterns

### Pre-flight
```typescript
if (git.isDirty()) { ui.error('Working tree is dirty...'); return 2; }
if (stack.restackState) { ui.error('Restack in progress...'); return 2; }
```

### PR base updates after array mutation
Loop through affected branches and update each PR's base:
```typescript
for (let i = startIndex; i < stack.branches.length; i++) {
    const branch = stack.branches[i];
    if (!branch?.pr) continue;
    const newBase = i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);
    try {
        gh.prEdit(branch.pr, { base: newBase });
    } catch { /* warn, don't fail */ }
}
```

No batch GraphQL mutation exists for `prEdit` — use sequential calls (matches `remove.ts` pattern).

### Dry-run output
Show a before/after table:
```
Current order:           New order:
  1. add-schema            1. add-types      (was 3)
  2. add-routes            2. add-schema     (was 1)
  3. add-types             3. add-routes     (was 2)
```

### `oldTips` for cascadeRebase
Snapshot ALL branch tips BEFORE mutating the array. The caller builds `oldTips` keyed by branch name from the pre-mutation state. This is critical because after array mutation, the ancestry expectations have changed.

---

## File organization

```
src/commands/
  move.ts       ← new
  insert.ts     ← new
  reorder.ts    ← new
```

Register all three in `cli.ts`. Update help text to add them to the "Branches" section.

---

## Implementation order

1. `move` — simplest, proves the pattern (array swap + cascade + PR retarget)
2. `insert` — builds on move's pattern, adds branch creation
3. `reorder` — generalization of move, but without auto-rebase
4. Help text update
