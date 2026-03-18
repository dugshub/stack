# Cascading Restack & Stack Graph

**Date:** 2026-03-18
**Status:** Approved

## Problem

When you restack a parent stack, any dependent stacks (created with `--base`) are left stale. You have to manually switch to each dependent stack and run `stack restack` separately. This is error-prone and tedious, especially with chains of dependencies (A → B → C).

Additionally, there's no way to visualize the dependency graph across stacks — you can only see individual stacks.

## Scope

1. **Cascading restack** (implement) — after restacking a stack, automatically detect and restack dependent stacks with confirmation
2. **Stack graph command** (implement) — `stack graph` shows the full dependency tree across all stacks

---

## Feature 1: Cascading Restack

### Design

After `doRestack()` completes successfully, scan all stacks for any whose `dependsOn.stack` matches the just-restacked stack name. For each, restack it (rebasing its first branch onto its updated trunk, then cascading downstream). Recurse to handle chains.

### New helper: `findDependentStacks()`

**File:** `src/lib/state.ts`

```ts
export function findDependentStacks(
  state: StackFile,
  stackName: string,
): Array<{ name: string; stack: Stack }> {
  const result: Array<{ name: string; stack: Stack }> = [];
  for (const [name, stack] of Object.entries(state.stacks)) {
    if (stack.dependsOn?.stack === stackName) {
      result.push({ name, stack });
    }
  }
  return result;
}
```

### Changes to `src/commands/restack.ts`

1. Add `cascade` option: `Option.Boolean('--cascade', true)` — clipanion auto-generates `--no-cascade` to flip it
2. After `doRestack()` succeeds, call a new `cascadeDependentStacks()` method
3. `cascadeDependentStacks(state, stackName, cascade, visited = new Set<string>())`:
   - **Cycle guard**: Add `stackName` to `visited`. If a dependent's name is already in `visited`, warn and skip.
   - Calls `findDependentStacks(state, stackName)`
   - If none found, return silently
   - For each dependent stack:
     - If `stack.restackState != null`: warn "restack already in progress on <name>, skipping" and continue
     - Print: `Stack "cache-stack" depends on "auth" (via user/auth/3-routes)`
     - If `!cascade` (--no-cascade): print tip and return without prompting
     - If TTY: prompt with `@clack/prompts` confirm (default yes). Skip on cancel/no.
     - If non-TTY: cascade automatically (consistent with other commands)
     - Restack the dependent stack from bottom (fromIndex = -1):
       - Save old tips for all branches
       - Rebase first branch onto its trunk (which is the parent stack's branch)
       - cascadeRebase for remaining branches
     - Recurse: call `cascadeDependentStacks(state, dependentName, cascade, visited)` for the dependent stack
   - If any dependent stack has conflicts, stop cascade and report. Print `stack restack --continue` (not `-s`, since `--continue` auto-finds the stack with `restackState`)

4. `--continue` also cascades: at the end of `doContinue()`, when `cascadeResult.ok`, call `cascadeDependentStacks(state, stackName, true, new Set())` to continue cascading to any dependent stacks

### Behavior

```
$ stack restack
✓ Rebased user/auth/2-middleware
✓ Rebased user/auth/3-routes
✓ Restacked 2 branches in "auth"

  Stack "cache-stack" depends on "auth" (via user/auth/3-routes)
? Restack dependent stack "cache-stack"? (Y/n) › Yes
  ℹ Rebasing user/cache/1-setup onto user/auth/3-routes...
✓ Rebased user/cache/1-setup
✓ Rebased user/cache/2-redis
✓ Restacked 2 branches in "cache-stack"
```

With `--no-cascade`:
```
$ stack restack --no-cascade
✓ Restacked 2 branches in "auth"
  ℹ Tip: stack "cache-stack" depends on this stack. Run `stack restack -s cache-stack` to update it.
```

### Edge cases

- **Conflict in dependent stack**: Stop cascade, save restackState on the dependent stack, print `stack restack --continue` (no `-s` needed — `doContinue()` auto-finds the stack with `restackState`)
- **Multiple dependents**: Process sequentially, prompt for each
- **Chain (A→B→C)**: Recursive with visited set — after B restacks, check for C
- **Circular dependency (A→B→A)**: Guarded by `visited` set — warn and skip
- **Dependent stack already has restackState**: Skip it, warn user
- **Non-TTY / CI**: Cascade without prompting (same as other commands)
- **Currently checked-out branch in dependent stack**: `rebaseBranch()` handles this via worktreeMap (rebases current branch in place)

---

## Feature 2: Stack Graph

### Design

A new `stack graph` command that renders the full dependency tree across all stacks using box-drawing characters. Compact, no new dependencies.

### Output format

```
Stack graph:

  main
  ├─ auth-stack         3 branches   👀 Review
  │  └─ cache-stack     2 branches   🔨 Draft
  └─ ui-fixes           1 branch     ✅ Merged

  develop
  └─ data-pipeline      4 branches   ✅ Approved
```

- Root nodes are trunks (main, develop, etc.)
- Child nodes are stacks, shown with branch count and aggregate status
- Aggregate status = worst status across all branches. Priority order (worst first): No PR → Draft → Changes Requested → Review Needed → Approved → Merged. Use a numeric ranking function to compare.
- Current stack highlighted with `← you are here`
- Stacks with no dependencies shown as direct children of their trunk

### Implementation

**File:** `src/commands/graph.ts`

```ts
export class GraphCommand extends Command {
  static override paths = [['graph']];
  static override usage = Command.Usage({
    description: 'Show dependency graph across all stacks',
  });

  async execute(): Promise<number> { ... }
}
```

**Algorithm:**
1. Load state, get all stacks
2. Group stacks by trunk (for independent stacks, trunk is a git branch like `main`)
3. For dependent stacks, nest them under their parent stack
4. Build a tree: `trunk → [stack → [dependent stack → ...]]`
5. Render with box-drawing characters (├─, └─, │)
6. For each stack node, fetch PR statuses and compute aggregate

**New UI helper in `src/lib/ui.ts`:**

```ts
export function stackGraph(
  nodes: GraphNode[],
  currentStackName: string | null,
): void { ... }

interface GraphNode {
  name: string;
  trunk: string;
  branchCount: number;
  aggregateStatus: StatusEmoji;
  isCurrent: boolean;
  children: GraphNode[];
}
```

### Registration

Add to `src/cli.ts`:
```ts
import { GraphCommand } from './commands/graph.js';
cli.register(GraphCommand);
```

Add to help text:
```ts
['graph', 'Show dependency graph across stacks'],
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/state.ts` | Add `findDependentStacks()` |
| `src/lib/types.ts` | No changes needed |
| `src/commands/restack.ts` | Add `--no-cascade`, `cascadeDependentStacks()` method |
| `src/commands/graph.ts` | New file — `GraphCommand` |
| `src/lib/ui.ts` | Add `stackGraph()` renderer |
| `src/cli.ts` | Register `GraphCommand`, add to help |

## Verification

```bash
# Verify restack cascade (need two stacks with dependency)
stack create test-parent -d first-branch
# ... make commits, create dependent stack ...
stack create test-child --base user/test-parent/1-first-branch -d child-branch
# ... amend parent, restack, verify cascade prompt appears

# Verify graph
stack graph

# Verify --no-cascade
stack restack --no-cascade

# Dry-run submit to verify nothing breaks
stack submit --dry-run
```
