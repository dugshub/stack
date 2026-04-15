# Multi-parent stacks (diamond dependencies)

Status: draft
Date: 2026-04-14

## Motivation

Today a `Stack` is a linear chain of branches rooted at a trunk, and a stack
may optionally depend on one other stack via a single `dependsOn: { stack,
branch }`. This rules out the diamond shape:

```
        A
       / \
      B   C
       \ /
        D
```

Use-case: D wants to compose two independent lines of work (B and C) that
both branched from A. Currently the user has to manually merge B into C (or
vice versa) outside the tool, and the stack representation is lost.

## Goal of this spec

Allow a stack to depend on **multiple** upstream branches, so a diamond can
be tracked, visualised, and — in later phases — restacked and submitted.

Non-goals for phase 1:
- Rebase/restack semantics across a merge commit (phase 2)
- Submit/PR creation changes (phase 3)
- Auto-generated merge commits at join points (phase 2)

## Design

### Data model

`src/lib/types.ts` — widen `dependsOn` from a single object to an array.

```ts
export interface StackParent {
  stack: string;
  branch: string;
}

export interface Stack {
  trunk: string;
  dependsOn?: StackParent[];   // was: { stack; branch }
  branches: Branch[];
  // ... unchanged
}
```

Exactly one entry means "linear fork" (today's behaviour). Two or more
entries means the first branch in the stack is a **join** branch — it must
contain a merge commit reachable from each parent tip.

Rationale for array-of-parents on the whole stack (rather than per-branch
`parents[]`):
- Today, inter-stack dependencies already live on the stack, not per-branch.
- A stack is still a linear chain internally; only the root of the chain
  can have multiple parents (that's the join point). Putting multi-parent
  support on the `Branch` would be more general but drags DAG semantics
  into every branch operation (move, reorder, fold, split) for no benefit.
- Keeps the blast radius small: restack/submit already treat `branches[]`
  as an ordered list; only the "what is the base of branches[0]?" question
  changes.

### Migration

Read and write are split intentionally:

- **`loadState` (read):** if `dependsOn` is a plain object, wrap it in a
  single-element array in memory. In-memory code only ever sees an array
  (or `undefined`).
- **`saveState` (write):** if a stack has exactly one parent, collapse
  `dependsOn` back to a plain object on disk. Older `st` builds (that
  predate this change) keep working against any state file the new build
  writes **as long as no diamond exists** in that file. Multi-parent
  stacks serialise as arrays — older builds will fail-loud on them, which
  is the correct behaviour.

This split is what keeps the rollback story sound: the collapse is
strictly at write time, and nothing else collapses. A builder should not
add collapse logic elsewhere.

All readers must be updated to handle an array. Convenience helpers live
in `src/lib/state.ts`:

```ts
export function stackParents(stack: Stack): StackParent[] {
  return stack.dependsOn ?? [];
}
export function primaryParent(stack: Stack): StackParent | undefined {
  return stack.dependsOn?.[0];
}
```

`findDependentStacks(state, stackName)` currently matches
`stack.dependsOn?.stack === stackName`. Change to
`stack.dependsOn?.some(p => p.stack === stackName)`.

**All call sites of `dependsOn` (verified via `rg "dependsOn" src/`):**

| File | Line(s) | Change |
|------|---------|--------|
| `src/lib/types.ts` | interface def | widen to `StackParent[]` |
| `src/lib/state.ts` | `findDependentStacks`, new helpers, load/save migration | array-aware |
| `src/commands/graph.ts` | `buildGraph`, `buildStackNode`, `collectChain` | iterate all parents; cycle guard (see below) |
| `src/commands/continue.ts` | ~154 (`depStack.dependsOn?.branch ?? depStack.trunk`) | `primaryParent(depStack)?.branch ?? depStack.trunk` |
| `src/commands/restack.ts` | ~158 (same pattern as continue) | same fix + phase-1 guard for `parents.length > 1` |
| `src/commands/delete.ts` | ~54 (`s.dependsOn?.stack === stackName`) | `stackParents(s).some(p => p.stack === stackName)` |
| `src/commands/remove.ts` | ~88 (`s.dependsOn?.branch === target.name`) | `stackParents(s).some(p => p.branch === target.name)` |
| `src/commands/sync.ts` | 62–64 (non-null asserted `dependsOn!.stack/branch`) | read `primaryParent(stack)`; for phase 1, sync only against the primary parent |
| `src/commands/status.ts` | 104–105 (emits raw `stack.dependsOn` in `--json`) | emit the array; document breaking JSON schema change |
| `src/commands/create.ts` | existing `--base` path writes singular `{stack, branch}` | write `[{stack, branch}]` when 1 parent, `[...parents]` when N |
| `src/lib/comment.ts` / `src/lib/stack-report.ts` | indirect via `dependsOn` for trunk row rendering | fall back to `primaryParent` for now; annotate secondary parents in a follow-up (phase 3) |

The resolve.ts and `src/server/*` files in the initial scoping guess do
**not** read `dependsOn` and need no changes.

### Create: declaring a diamond

`src/commands/create.ts` — keep `--base` as `Option.String` (preserves the
documented `--base .` "current branch" shorthand) and add a new
`--also-base` `Option.Array` for secondary parents.

```bash
# Current: fork off a single branch (unchanged)
st create new-stack --base user/feat/2-b

# New: join two branches into a merge stack
st create merge-bcd \
  --base user/feat/2-b \
  --also-base user/feat-alt/1-c \
  --description combine
```

When one or more `--also-base` values are given:
1. Verify every base branch (primary + all secondaries) exists and
   resolves to a stack+branch pair.
2. Primary parent = `--base`. Secondaries = `--also-base` in declared
   order. New stack's `trunk` stores the primary parent's branch name.
3. Create the join branch off the primary parent's tip, then run an
   octopus merge: `git merge --no-ff <secondary1> <secondary2> ...`. Git
   aborts cleanly on any conflict during an octopus merge, which is what
   we want for phase 1 — no `--resume` plumbing needed. On conflict: print
   the conflict message, leave the branch in its pre-merge state
   (`git merge --abort` is run automatically), write **no** state, exit
   non-zero.
4. Persist `dependsOn: [primary, ...secondaries]`.

Phase 1 acceptance criterion: the command refuses gracefully if the
octopus merge would conflict (no stale branch, no stale state), and
succeeds otherwise.

### Graph rendering

`src/commands/graph.ts` and `src/lib/interactive-graph.ts` — today the
tree builder groups stacks by trunk and nests dependents by the single
`dependsOn.branch`. With multiple parents we need to:

1. **Index dependents by every parent branch.** `buildGraph` / `buildStackNode`
   walk `findDependentStacks`. Update to iterate `depStack.dependsOn ?? []`
   and register the dependent under each parent branch's `forkMap` entry.

2. **Mark multi-parent join stacks distinctly.** When rendering a stack
   node whose own `dependsOn.length > 1`, draw the extra parents as
   dashed "also-depends-on" lines. Proposed glyph:

   ```
     ● feat                           (primary chain)
     ├─● 1-a  #101  ✅
     │ ├─◆ bcd   ← join of [feat/2-b, feat-alt/1-c]
     │ │ └─● 1-merge  #200  ✅
     ├─● 2-b  #102  ✅
     └─● feat-alt
        └─● 1-c  #110  ✅  ╌╌┐
                              ╌→ joined into `bcd`
   ```

   Concrete rendering choices (kept small):
   - New glyph `DOT_JOIN = '\u25C6'` (◆) in `src/lib/ui.ts` for a
     multi-parent stack node.
   - Under the primary parent branch, render the join stack normally.
   - Under **secondary** parent branches, render a one-line pointer
     referencing the join stack by name, using a dashed connector
     (`╌╌→ joined into bcd`). No full nested rendering — avoids
     duplicating an entire subtree.
   - `GraphStackNode` gains `joinParents?: StackParent[]` (the
     non-primary parents) so the flattener in `interactive-graph.ts`
     can render the header with an annotation.

3. **Selectable cursor behaviour.** The secondary-parent pointer line is
   non-selectable; pressing enter jumps via the primary rendering only.

4. **Chain collection.** `collectChain` walks `dependsOn?.stack` upward
   recursively. Replace with a walk over `dependsOn ?? []` so a diamond's
   `--stack` filter includes both ancestor chains. Use a visited set
   (`seen: Set<string>`) in the ancestor walk to guard against malformed
   cyclic `dependsOn` data — `walkDown` already has this guard via
   `chain.has(...)`; the ancestor walk must match it.

The existing `interactive-graph.ts` flattener does **not** need a wider
refactor. Adding `joinParents?: StackParent[]` to `GraphStackNode` and a
new non-selectable branch in `flattenExpandedBranches` that emits the
dashed pointer is the complete UI change.

### Restack (phase 2 — out of scope for build)

Sketch only, to make sure phase 1 doesn't box us in:
- A join stack's `branches[0]` is a merge commit with parents
  `(primary, secondary, ...)`. When any parent tip moves, the correct
  "rebase" is `git rebase --rebase-merges` (or recreate the merge
  commit with `git merge` after resetting to the new primary tip).
- `cascadeRebase` runs inside a stack and treats `i === 0`'s parent as
  `stack.trunk`. That still works for join stacks because `trunk` is the
  primary parent branch name. The secondary parents must be passed in
  separately and a merge step runs before the branch is considered
  up-to-date. A new helper `rebaseJoin(stack, parents[])` is the likely
  shape.
- `branch.parentTip` becomes insufficient — we need `parentTips` keyed by
  parent branch name. Add `parentTips?: Record<string, string>` on
  `Branch` (leave `parentTip` populated for back-compat).

Phase 1 **preserves** existing `parentTip` semantics and does not touch
`rebase.ts`; a restack attempt on a diamond stack will either succeed
trivially (no parent moved) or fail loudly. An explicit guard in
`restack.ts` checks `stack.dependsOn && stack.dependsOn.length > 1` and
bails with: *"Multi-parent stacks cannot be restacked yet — coming in
phase 2."*

### Submit (phase 3 — out of scope for build)

Notes only:
- `comment.ts` / `stack-report.ts` would need a second "joined from" row
  on the join PR's stack comment.
- The PR base for `branches[0]` on a join stack is the primary parent
  (that's already how linear forks work via `trunk`). Secondary parents
  are informational only in the comment.
- Phase 1 guard: `submit` on a multi-parent stack prints a warning that
  only the primary parent is reflected in the PR base, and the stack
  navigation comment omits secondary parents. Does not block submission.

## Phase 1 deliverables

1. `types.ts` — `dependsOn` becomes `StackParent[]`; add `StackParent`.
2. `state.ts` — read-time migration (object → array); write-time collapse
   (single-element array → object); helpers `stackParents`, `primaryParent`;
   `findDependentStacks` uses `.some`.
3. `create.ts` — add `--also-base` (`Option.Array`); octopus merge path;
   persist `dependsOn` array.
4. `graph.ts` + `interactive-graph.ts` + `ui.ts` — index dependents by
   every parent; `◆` glyph + `DOT_JOIN` in `ui.ts`; dashed pointer under
   secondary parents via `joinParents` on `GraphStackNode`;
   `collectChain` walks all ancestors with visited-set cycle guard.
5. `continue.ts` — replace `depStack.dependsOn?.branch` with
   `primaryParent(depStack)?.branch`.
6. `restack.ts` — replace the same pattern; add guard rail that refuses
   `st restack` on a stack with `stackParents(stack).length > 1`.
7. `delete.ts` — `stackParents(s).some(p => p.stack === stackName)`.
8. `remove.ts` — `stackParents(s).some(p => p.branch === target.name)`.
9. `sync.ts` — read `primaryParent(stack)`; phase 1 sync is
   primary-parent-only (document in warning text).
10. `status.ts` — emit the `dependsOn` array in `--json` output
    unchanged from in-memory form; note the breaking JSON schema change
    in the PR description.
11. `stack-report.ts` / `comment.ts` — read `primaryParent` for the
    "depends on" trunk row; secondary parents deferred to phase 3.
12. `submit.ts` — warning on multi-parent submit; no behaviour change.

Explicitly out of phase 1: rebase semantics, PR base reassignment,
AI-description integration, `--resume` for conflicted merges, rendering
secondary parents in PR comments.

## Test plan

No automated test suite exists. Manual verification:

1. **Migration.** Load a pre-existing state file with `dependsOn` as an
   object. Run `st graph`. Confirm it renders identically to before and
   that the next save converts the field to a single-element array.
2. **Linear fork still works.** `st create child --base user/a/1-x`
   against existing stack `a`. Graph should render unchanged.
3. **Diamond creation.** Given stacks `feat` (with branches `1-a`, `2-b`)
   and `feat-alt` (depends on `feat@1-a`, branch `1-c`):
   ```
   st create bcd --base user/feat/2-b --base user/feat-alt/1-c -d combine
   ```
   Expected: branch `user/bcd/1-combine` created with a merge commit of
   `2-b` and `1-c`; state shows `dependsOn: [{feat, 2-b}, {feat-alt, 1-c}]`.
4. **Graph diamond render.** `st graph` and `st graph --expand` show the
   `◆` join node under `2-b` and a dashed pointer under `1-c` referencing
   `bcd`.
5. **Interactive graph.** `st` (default command) still navigates; the
   pointer line under `1-c` is not selectable; enter on `bcd`'s branch
   checks it out cleanly.
6. **Restack guard.** `st restack` on `bcd` prints the phase-2-pending
   message and exits non-zero without mutating git state.
7. **Submit warning.** `st submit --dry-run -s bcd` prints the warning
   and the dry-run plan for the primary parent only.
8. **Conflicting merge on create.** Create a diamond where `2-b` and
   `1-c` edit the same line. `st create ...` refuses with a clean error
   and no stale branch or state left behind.
9. **Lint / typecheck.** `bun x tsc --noEmit` clean; `bun x biome check`
   (or project equivalent) clean.

## Rollback

All state changes are additive + back-compat at read time. If phase 1
ships and we need to roll back, users on the new build see arrays; older
builds would choke on an array. Mitigation: add a small shim in the
**old** build before shipping phase 1 that tolerates the array shape
(read the first entry). Alternatively, gate array writes behind the
presence of >1 parent — write a plain object when there's only one. The
plan picks the latter: in `saveState`, collapse single-element
`dependsOn` to the legacy object shape on disk, so old builds keep
working on any state file the new build produces where no diamond
exists.

## Open questions

- Should the primary parent be user-choosable (e.g. `--base X --also-base Y`),
  or always the first `--base`? Current plan: first `--base` wins.
- What PR base does the join branch use on GitHub? Phase 1 uses the
  primary parent. A richer model might push a combined base branch
  (rare — GitHub doesn't model multi-parent PRs).
- Should the legacy-object-on-disk rollback remain forever, or flip to
  always-array after one release? Defer.
