# Stack Comment Direction & Order

## Problem

The stack navigation comment on PRs renders as a flat bullet list with no visual hierarchy:

```
### PR Stack
* #17
* #18
* #19
* **#20** 👈
* `main`
```

There's no indication of direction (which PR is the top of the stack, which is the base), no arrows showing merge flow, and the ordering is ambiguous.

## Solution

Reverse the render order (top of stack first) and add directional arrows between entries to show the merge flow. The new format:

```
### PR Stack

  #20  👈
  ↓
  #19
  ↓
  #18
  ↓
  #17
  ↓
  `main`
```

Key changes:
1. **Reverse iteration** — render from last branch (top of stack) down to first branch (closest to trunk), then trunk
2. **Arrow separators** — use `↓` between entries to show merge direction (each PR merges into the one below)
3. **Remove bullet points** — use plain lines instead of `*` bullets for cleaner look
4. **Keep existing markers** — bold + 👈 for current PR

## File Changes

### `src/lib/comment.ts`

Replace the rendering loop:

```typescript
export function generateComment(
  stack: Stack,
  currentPrNumber: number,
  _prStatuses: Map<number, unknown>,
  _repoUrl: string,
): string {
  const lines: string[] = [];

  lines.push(COMMENT_MARKER);
  lines.push('');

  // Render top-of-stack first (last branch in array = top)
  const entries: string[] = [];

  for (let i = stack.branches.length - 1; i >= 0; i--) {
    const branch = stack.branches[i];
    if (!branch) continue;

    const isCurrent = branch.pr === currentPrNumber;
    const prRef = branch.pr != null ? `#${branch.pr}` : branch.name;

    if (isCurrent) {
      entries.push(`**${prRef}** 👈`);
    } else {
      entries.push(prRef);
    }
  }

  // Add trunk at the bottom
  entries.push(`\`${stack.trunk}\``);

  // Join with arrow separators
  lines.push(entries.join('\n↓\n'));

  lines.push('');
  lines.push('<sub>Managed by Claude Code <code>/stack</code></sub>');

  return lines.join('\n');
}
```

## Verification

Run `bun run src/cli.ts submit --dry-run` on a branch with a stack to see the new comment format.
