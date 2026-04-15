# Multi-Stack PR Comment Rendering

> Show the full chain of nested stacks in PR navigation comments, so reviewers can see upstream and downstream context.

## Status: VALIDATED

---

## Motivation

Users increasingly have deeply nested stack chains: a stack of 5 branches dependent on an upstream stack of 3, which depends on another stack. Today, the PR comment only shows the current stack's branches with a single `↳ parent-stack` pointer at the bottom. There's no visibility into the full chain — reviewers can't see what stacks sit above or below.

## Current State

`comment.ts:generateComment()` renders:

```
### PR Stack `my-stack`

| Status | PR | Title |
|--------|-----|-------|
| 👀 Review | **#20** | **My Feature** 👈 |
| 🔨 Draft | #19 | Setup |
| | ↳ `parent-stack`#5 | |
```

One level of parent reference. No downstream stacks shown. No chain visibility.

## Design

### Rendering Format

Extend the existing table to include summary rows for neighboring stacks. Downstream stacks (that depend on the current stack) appear above the current stack's branches. Upstream stacks (that the current stack depends on) appear below, leading to trunk.

Each neighbor stack gets exactly one summary row with: aggregate status emoji, stack name with directional indicator, and branch count.

```
### PR Stack `my-stack`

| Status | PR | Title |
|--------|-----|-------|
| 🔨 Draft | ↖ `child-stack` | 2 branches |
| 👀 Review | **[#20](url)** | **My Feature** 👈 |
| 🔨 Draft | [#19](url) | Setup |
| ✅ Approved | ↳ `parent-stack` | 3 branches |
| ✅ Merged | ↳ `grandparent` | 2 branches |
| | `main` | |

<sub>Managed by <a href="...">stack CLI</a></sub>
```

Key decisions:
- `↖` prefix for downstream stacks (depend on us, sit above in merge chain)
- `↳` prefix for upstream stacks (we depend on them, sit below toward trunk)
- Aggregate status uses existing `aggregateStatusEmoji()` from `ui.ts`
- Status text uses a new exported `statusTextForEmoji(emoji: StatusEmoji): string` helper in `ui.ts` (since `statusFromEmoji` is private)
- Neighbor rows show branch count (e.g., "3 branches") instead of a PR title
- Multiple downstream stacks at the same level each get their own row
- Depth limit: default 3 stacks in each direction, configurable via `StackConfig.commentDepth`

### Depth Traversal

**Upstream:** Linear chain via `primaryParent()`. Walk: current → parent → grandparent → ... → trunk. Stop at `depth` stacks or when reaching a stack with no `dependsOn`.

**Downstream:** Tree via `findDependentStacks()`. Walk breadth-first from current stack. At each level, all direct dependents are included. Stop at `depth` levels deep. Multiple dependents at the same level each get a summary row.

### Data Requirements

For each neighbor stack, we need:
- Stack name
- Branch count (`stack.branches.length`)
- PR numbers for all branches (to compute aggregate status)
- Aggregate PR status

PR statuses for neighbor stacks are fetched via `gh.prViewBatch()` (existing batch GraphQL helper) in the submit/sync flows.

---

## Changes

### 1. `src/lib/types.ts` — Add config field

Add `commentDepth` to `StackConfig`:

```typescript
export interface StackConfig {
  describe?: boolean;
  describeHintDismissed?: boolean;
  commentDepth?: number;  // NEW — max stacks shown in each direction (default: 3)
}
```

### 2. `src/lib/ui.ts` — Export status text helper

`statusFromEmoji()` at `ui.ts:388` is a private function. Add a new **exported** helper that maps `StatusEmoji` to display text without needing `PrStatus`:

```typescript
export function statusTextForEmoji(emoji: StatusEmoji): string {
  switch (emoji) {
    case '⬜': return 'No PR';
    case '✅': return 'Approved';
    case '❌': return 'Closed';
    case '🔨': return 'Draft';
    case '🔄': return 'Changes';
    case '👀': return 'Review';
    default: return '';
  }
}
```

This avoids the round-trip through `statusFromEmoji()` → `statusText()` and keeps the private function private.

### 3. `src/lib/comment.ts` — Multi-stack rendering

Add a `NeighborStack` interface and update `generateComment`:

```typescript
import type { StatusEmoji } from './types.js';
import { statusTextForEmoji } from './ui.js';

export interface NeighborStack {
  name: string;
  branchCount: number;
  aggregateStatus: StatusEmoji;
  direction: 'upstream' | 'downstream';
}
```

Update `generateComment` signature to accept optional neighbor context:

```typescript
export interface NeighborContext {
  neighbors: NeighborStack[];
  rootTrunk: string;  // resolved trunk of the root ancestor (e.g., "main")
}

export function generateComment(
  stack: Stack,
  currentPrNumber: number,
  prStatuses: Map<number, PrStatus>,
  repoUrl: string,
  neighborCtx?: NeighborContext,
): string
```

**Note:** `generateComment` currently calls `buildReport()` from `stack-report.ts` (line 14) which returns a `StackReport` with `rows`, `trunk`, `dependsOn`, and `prefix`. The neighbor rows are rendered **around** the report's branch rows. The `buildReport()` function itself is unchanged.

Rendering logic:
1. Render header (unchanged — uses `report.prefix` for stack label)
2. Render table header (unchanged)
3. **NEW:** Render downstream neighbor rows (filtered from `neighborCtx.neighbors` where `direction === 'downstream'`, in reverse order so outermost is at top)
4. Render current stack's branch rows (unchanged — iterates `report.rows`)
5. **CHANGED:** When `neighborCtx` is provided with upstream neighbors, replace the existing `dependsOn`/trunk row with upstream neighbor rows followed by a `rootTrunk` row. When `neighborCtx` is absent/empty, fall back to existing behavior (single `dependsOn` or trunk row).
6. Render footer (unchanged)

Each neighbor row format:
```typescript
const arrow = neighbor.direction === 'downstream' ? '↖' : '↳';
const branchLabel = neighbor.branchCount === 1 ? '1 branch' : `${neighbor.branchCount} branches`;
const statusCell = `${neighbor.aggregateStatus} ${statusTextForEmoji(neighbor.aggregateStatus)}`;
lines.push(`| ${statusCell} | ${arrow} \`${neighbor.name}\` | ${branchLabel} |`);
```

### 4. `src/lib/comment.ts` — Chain-building helper

Add a function to collect the neighbor chain from state. Returns a structured result including the resolved root trunk:

```typescript
export interface NeighborChainResult {
  upstream: NeighborStack[];    // ordered: immediate parent first, root ancestor last
  downstream: NeighborStack[];  // ordered: immediate dependents first, outermost last
  rootTrunk: string;            // trunk of the root ancestor stack (e.g., "main")
}

export function collectNeighborChain(
  state: StackFile,
  currentStackName: string,
  prStatuses: Map<number, PrStatus>,
  depth: number = 3,
): NeighborChainResult
```

Algorithm:
1. **Walk upstream:** Starting from `currentStackName`, look up the stack via `state.stacks[name]`, call `primaryParent(stack)` to get `StackParent`, use `parent.stack` to look up the next stack in `state.stacks`. Repeat up to `depth` levels. For each ancestor stack found, compute aggregate status by mapping `stack.branches` → `statusEmoji(prStatuses.get(branch.pr))` → `aggregateStatusEmoji(emojis)`. Track the deepest ancestor's `trunk` as `rootTrunk`.
2. **Walk downstream:** Starting from `currentStackName`, call `findDependentStacks(state, name)` which returns **direct dependents only** (one level). Queue each dependent and repeat BFS up to `depth` levels deep. Use a `Set<string>` to guard against cycles. For each dependent stack, compute aggregate status same as above.
3. If no upstream stacks found, `rootTrunk` defaults to the current stack's `trunk`.
4. Return `{ upstream, downstream, rootTrunk }`.

This function uses `primaryParent(stack: Stack)` and `findDependentStacks(state, stackName)` from `state.ts`, and `aggregateStatusEmoji()` + `statusEmoji()` from `ui.ts`.

### 5. `src/commands/submit.ts` — Pass neighbor data

In the comment phase (Phase 6), after building `prStatuses` for the current stack:

1. Determine depth from `state.config?.commentDepth ?? 3`
2. Gather all PR numbers from neighbor stacks' branches by walking the chain in state
3. Batch-fetch neighbor PR statuses via `gh.prViewBatch(neighborPrNumbers)` — a single additional GraphQL call. This returns `Map<number, PrStatus>` directly, which is what we need. (Note: submit.ts uses `graphql.fetchPRDetails()` for the current stack which returns `PRDetails`, but `prViewBatch` is simpler and sufficient for neighbors since we only need aggregate status, not node IDs or bot comments.)
4. Merge neighbor statuses into the combined `prStatuses` map
5. Call `collectNeighborChain(state, resolvedName, prStatuses, depth)` to build the chain
6. Build `NeighborContext` from the chain result
7. Pass to `generateComment(stack, branch.pr, prStatuses, repoUrl, neighborCtx)`

### 6. `src/commands/sync.ts` — Same pattern (different comment mechanism)

In the comment-update section (step 7), apply the same neighbor-gathering logic. Note: sync posts comments via `gh.prComment()` (which uses `gh pr comment --edit-last --create-if-none`), not GraphQL mutations like submit. This is fine — the `generateComment()` output is just a string regardless of how it's posted.

---

## Backward Compatibility

- `generateComment` gets an optional `neighbors` parameter — existing callers work without changes
- When `neighbors` is `undefined` or empty, behavior is identical to today (including the single `dependsOn` row)
- The `StackConfig.commentDepth` field is optional with a sensible default (3)
- No changes to state file format

## Edge Cases

1. **Single stack (no dependencies):** No neighbors, renders exactly as today
2. **Stack with only upstream (no downstream dependents):** Only upstream rows shown below branches
3. **Stack with only downstream (root stack with dependents):** Only downstream rows shown above branches
4. **Circular dependencies:** Guard against cycles in chain walking (use a `Set<string>` of visited stacks)
5. **Deleted/missing neighbor stack:** Skip if stack name not found in `state.stacks`
6. **Neighbor PRs not yet created:** `aggregateStatusEmoji` returns `⬜` for stacks with no PRs — this is correct
7. **Depth limit exceeded:** Stop walking at configured depth, don't show an ellipsis (the chain is just truncated)

## Verification

```bash
# On a branch in a dependent stack with upstream/downstream neighbors:
bun run src/cli.ts submit --dry-run
# Verify the generated comment includes neighbor stack rows

# On a standalone stack (no dependencies):
bun run src/cli.ts submit --dry-run
# Verify behavior is unchanged
```

## Affected Files Summary

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `commentDepth` to `StackConfig` |
| `src/lib/ui.ts` | Add exported `statusTextForEmoji()` helper |
| `src/lib/comment.ts` | Add `NeighborStack`, `NeighborContext`, `NeighborChainResult`, `collectNeighborChain()`; update `generateComment()` |
| `src/commands/submit.ts` | Gather neighbor data, pass to `generateComment()` |
| `src/commands/sync.ts` | Same as submit |

Files **not** changed: `stack-report.ts` (the `buildReport()` function and `StackReport` type remain as-is), `graphql.ts` (no changes needed — neighbor statuses use `gh.prViewBatch()` separately).

## Implementation Order

1. Add `commentDepth` to `StackConfig` in `types.ts`
2. Add `statusTextForEmoji()` to `ui.ts`
3. Add `NeighborStack`, `NeighborContext`, `NeighborChainResult` interfaces and `collectNeighborChain()` to `comment.ts`
4. Update `generateComment()` rendering to include neighbor rows
5. Update `submit.ts` to gather neighbor data and pass to `generateComment`
6. Update `sync.ts` similarly
7. Test with `--dry-run` on both dependent and standalone stacks
