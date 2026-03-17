# Absorb: Manual Routing & Partial Control

**Date:** 2026-03-16
**Status:** Draft

## Problem

`stack absorb` currently handles three file categories:
- **Absorbable** (single owner) — auto-routed and committed
- **Conflicted** (multiple owners) — skipped, restored to working tree
- **Unowned** (no owner) — skipped, restored to working tree

The auto-routing works well for clean cases, but users have no way to manually route the conflicted/unowned files. After absorb runs, they must manually `stack nav`, `git add`, `git commit` for each leftover file — losing the benefit of absorb's restack machinery.

**Real-world scenario:** A cross-cutting refactor (e.g., removing `resolveRowId`) touches files owned by different branches. Absorb can auto-route 2 of 8 files. The remaining 6 require tedious manual branch-hopping.

## Solution

Add `--branch <N>` flag for explicit file routing, where `<N>` is the 1-based branch position in the stack.

### New CLI Signatures

```bash
# Route specific files to a branch (overrides ownership detection)
stack absorb --branch 5 GroupedTable.tsx DataTable.tsx

# Combine: auto-absorb clean files + route specific files
stack absorb --branch 4 render-row.tsx DataTable.tsx

# Dry-run with manual routing to preview
stack absorb --branch 5 GroupedTable.tsx --dry-run
```

### Behavior

When `--branch <N>` is provided with positional file args:

1. **Positional args are file paths** — these files are force-routed to branch N regardless of ownership
2. **Remaining dirty files** (not listed as positional args) follow normal auto-routing
3. Both manual and auto-routed files are processed in a single bottom-to-top pass
4. The `--dry-run` flag works as before, showing the combined plan

### Edge Cases

- If a positional file isn't dirty → warn and skip it
- If branch index is out of range → error with valid range
- Files listed in `--branch` that would also be auto-routed → manual routing wins (explicit > implicit)
- Multiple `--branch` invocations are NOT supported in a single call (keep it simple — run absorb multiple times for multiple manual targets)

## Implementation

### Changes to `src/commands/absorb.ts`

**1. Add new options:**

```typescript
branchTarget = Option.String('--branch,-b', {
  description: '1-based branch index to route files to',
});

files = Option.Rest();
```

**2. Modify classification logic (lines 101-121):**

Before the existing classification loop, process manual overrides:

```typescript
// Manual routing: --branch N file1 file2
const manualRoute = new Map<number, string[]>(); // branchIndex -> files
const manualFiles = new Set<string>();

if (this.branchTarget !== undefined) {
  const idx = parseInt(this.branchTarget, 10) - 1; // 1-based → 0-based
  if (isNaN(idx) || idx < 0 || idx >= stack.branches.length) {
    ui.error(`Branch index must be between 1 and ${stack.branches.length}`);
    return 2;
  }

  const restArgs = this.files ?? [];
  if (restArgs.length === 0) {
    ui.error('--branch requires file paths as positional arguments');
    return 2;
  }

  const validFiles: string[] = [];
  for (const file of restArgs) {
    if (dirty.includes(file)) {
      validFiles.push(file);
      manualFiles.add(file);
    } else {
      ui.warn(`${file} is not dirty — skipping`);
    }
  }

  if (validFiles.length > 0) {
    manualRoute.set(idx, validFiles);
  } else {
    ui.error('None of the specified files have uncommitted changes');
    return 2;
  }
}
```

Then modify the classification loop to skip manually-routed files:

```typescript
for (const file of dirty) {
  if (manualFiles.has(file)) continue; // handled by --branch
  // ... existing classification logic
}
```

**3. Merge manual routes into absorbable map (BEFORE the early-exit guard):**

This must happen before the `absorbable.size === 0` check at line 155, otherwise
`stack absorb --branch 2 shared.ts` on a conflicted file would exit with
"No files can be absorbed" before the manual override is applied.

```typescript
// Merge manual routes into the absorbable map
for (const [idx, files] of manualRoute) {
  const existing = absorbable.get(idx) ?? [];
  existing.push(...files);
  absorbable.set(idx, existing);
}

// THEN the existing early-exit guard:
if (absorbable.size === 0) { ... }
```

**4. Update plan display to distinguish manual vs auto-routed:**

In the display section, annotate manually-routed files:

```typescript
for (const file of files) {
  const isManual = manualFiles.has(file);
  ui.info(`  ${file}${isManual ? theme.muted(' (manual)') : ''}`);
}
```

**5. Update `Command.Usage` examples:**

```typescript
static override usage = Command.Usage({
  description: 'Route uncommitted fixes to the correct stack branches',
  examples: [
    ['Absorb changes into their owning branches', 'stack absorb'],
    ['Preview without making changes', 'stack absorb --dry-run'],
    ['Route files to branch 5 manually', 'stack absorb --branch 5 GroupedTable.tsx'],
    ['Absorb with a custom commit message', 'stack absorb -m "fix typos"'],
  ],
});
```

### No other files need changes

The execution logic (stash, bottom-to-top pass, rebase, commit, restore) already works generically with the `absorbable` map. By merging manual routes into `absorbable` before the early-exit guard, the entire existing machinery handles it.

## Tests to Add

1. **`--branch routes file to specified branch`** — modify a file, absorb with `--branch 2`, verify it lands in branch 2
2. **`--branch with non-dirty file warns and skips`** — pass a clean file, verify warning
3. **`--branch out of range errors`** — pass index 0 or > branch count
4. **`--branch without files errors`** — just `--branch 3` with no args
4b. **`--branch with all-clean files errors`** — pass files that aren't dirty, verify error after skip warnings
5. **`--branch overrides ownership`** — modify a file owned by branch 1, route to branch 2 with `--branch 2`, verify it lands in branch 2
6. **`--branch + auto-absorb combined`** — dirty 3 files: one auto-routable, one manually routed, one unowned. Verify first two are absorbed, third is restored.
7. **`--branch dry-run shows manual annotation`** — verify `(manual)` appears in plan output

## Not In Scope

- **Multiple `--branch` flags per invocation** — adds complexity for marginal gain. Run absorb twice.
- **Hunk-level routing** — matching hunks to commits (like `git absorb`) is a separate, larger feature. File-level routing covers 80% of the use case.
- **Interactive mode** — prompting "which branch for X?" per ambiguous file. Nice-to-have, but not needed for the core workflow.
