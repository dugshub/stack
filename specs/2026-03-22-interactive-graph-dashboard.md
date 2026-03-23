# Interactive Graph Dashboard

**Date:** 2026-03-22
**Status:** Ready

## Summary

Replace the static dashboard (`st` with no args) with an interactive graph view. The expanded graph (`st graph --expand`) becomes the default "home screen" — rendered with a navigable cursor so users can browse branches across all stacks and take actions directly.

## Motivation

`st graph --expand` is the most visually compelling view in the tool, especially for multi-stacked repos. But it's static and disconnected — you see the graph, then have to type a separate command to act. Meanwhile, `st nav` is interactive but scoped to a single stack. The goal is to combine the best of both: the full dependency graph with interactive navigation.

## UX Design

### What the user sees

Running `st` (no args, TTY) renders the full expanded graph with a **selection cursor** highlighting one branch at a time:

```
  ● stacks  ○ branches  ◉ current  ◇ trunk

  ◇ main
  │
  ├─● auth-flow
  │ ├ ○ 1-add-schema      #101  👀 Review
  │ ├ ◉ 2-add-migration   #102  🔨 Draft       ← you are here
  │ ╰ ○ 3-add-api         #103  ⬜ No PR
  │
  ╰─● billing
    ├ ○ 1-stripe-setup     #201  ✅ Approved
    ╰ ○ 2-webhook-handler  #202  👀 Review

  ↑↓/jk navigate · enter checkout · o open PR · q quit
```

The **selected** branch gets a highlight (reverse video or accent color). On startup, the cursor lands on the current branch (the `◉` one).

### Keyboard bindings

| Key | Action |
|-----|--------|
| `↑` / `k` | Move cursor to previous branch (skips non-branch lines) |
| `↓` / `j` | Move cursor to next branch (skips non-branch lines) |
| `Enter` | Checkout the selected branch, exit |
| `o` | Open the selected branch's PR in browser (`gh pr view --web`) |
| `q` / `Escape` / `Ctrl-C` | Quit without action |

### Non-TTY fallback

When stdin is not a TTY (piped, CI, scripts), fall back to the current static dashboard output. No behavior change for non-interactive contexts.

## Architecture

### Data flow

```
loadAndRefreshState() → buildGraph(expandAll=true) → flattenToLines() → interactiveSelect() → action
```

1. **Build graph** — Reuse existing `buildGraph()` from `graph.ts` with `expandAll: true` (already handles multi-stack trees, dependency chains, PR statuses). Must use `expandAll: true` so all stacks have `branches` populated, not just the current one.
2. **Flatten to lines** — Convert the tree into a flat array of `GraphLine` objects, each with rendering text and metadata about whether it's selectable. Each visual line (including blanks/separators) gets exactly one entry for correct cursor-up math.
3. **Interactive select** — Raw terminal loop: render lines, handle keypresses, update cursor position
4. **Action** — On Enter: checkout (with auto-stash). On `o`: open PR. On quit: clean exit.

### New types

```ts
interface GraphLine {
  /** The full rendered line (with ANSI colors, tree chars, etc.) */
  text: string;
  /** Highlighted version of the line (when cursor is on it) */
  highlightedText: string;
  /** Whether this line is a selectable branch */
  selectable: boolean;
  /** Branch name for checkout (only if selectable) */
  branchName?: string;
  /** Stack name this branch belongs to */
  stackName?: string;
  /** PR number (for opening in browser) */
  pr?: number;
  /** Whether this is the user's current branch */
  isCurrent: boolean;
}
```

### Key implementation detail: Line-based rendering

Rather than modifying `renderStackGraph()` to return lines (which would break its existing callers and duplicate formatting logic), we create a **parallel rendering path** that produces `GraphLine[]`:

- `flattenGraphToLines(roots)` walks the same `GraphStackNode[]` tree
- Produces exactly one `GraphLine` per visual output line, including blank separator lines (critical for cursor-up re-render math: `N = lines.length`)
- Uses the same tree characters, alignment, and formatting as `renderStackGraph` but captures output instead of writing to stderr
- Branch lines are marked `selectable: true` with their metadata

This keeps `renderStackGraph()` untouched for `st graph` and other callers.

### Terminal UI implementation

**TTY detection:** Use `isatty(0)` from `node:tty` (NOT `process.stdin.isTTY` which is unreliable in Bun global installs — see `theme.ts` lines 6-9 for prior art).

**Raw mode approach:** Use Bun's `Bun.stdin` with raw mode, or wrap fd 0 as a `tty.ReadStream` from `node:tty` for reliable `setRawMode` support. The `@clack/prompts` library handles this internally via `readline.createInterface` — we follow a similar pattern:

```ts
import { isatty } from 'node:tty';
import * as readline from 'node:readline';

function interactiveGraphSelect(lines: GraphLine[], initialIndex: number): Promise<GraphAction> {
  return new Promise((resolve) => {
    // Use readline for cross-runtime key handling
    const rl = readline.createInterface({ input: process.stdin });
    readline.emitKeypressEvents(process.stdin, rl);
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);

    let cursor = initialIndex;
    const selectableIndices = lines
      .map((l, i) => l.selectable ? i : -1)
      .filter(i => i >= 0);

    render(lines, cursor);

    process.stdin.on('keypress', (str, key) => {
      // Handle arrow keys, j/k, enter, o, q, escape, ctrl-c
      // Move cursor, re-render, or resolve with action
    });
  });
}
```

Rendering approach:
- First render: write all lines + footer to stderr
- Subsequent renders: move cursor up N lines (`\x1b[${lines.length}A`), clear to end of screen (`\x1b[J`), redraw — N is exactly `lines.length` because every visual line (including blanks) has a `GraphLine` entry
- On exit: leave the final render visible (don't clear), restore stdin

## File Changes

### 1. `src/lib/interactive-graph.ts` (NEW)

The core interactive UI module. Contains:

- `flattenGraphToLines(roots, currentBranch)` — Walks graph tree, produces `GraphLine[]`
- `interactiveGraphSelect(lines, initialIndex)` — readline keypress loop, returns action
- `showInteractiveGraph()` — Top-level orchestrator: loads state, builds graph, fetches PR statuses, runs interactive select, executes action (including auto-stash for checkout)
- Helper: line rendering functions that mirror `renderStackGraph` but output to array

**Size estimate:** ~300 lines

### 2. `src/lib/pr-status.ts` (NEW)

Extract `fetchAllPrStatuses(state: StackFile): Promise<Map<number, PrStatus>>` from `dashboard.ts` into a shared module. Currently duplicated in both `dashboard.ts` (standalone function) and `graph.ts` (class method). After extraction:
- `dashboard.ts` imports from `pr-status.ts`
- `graph.ts` imports from `pr-status.ts` (replace the private class method)
- `interactive-graph.ts` imports from `pr-status.ts`

**Size estimate:** ~25 lines

### 3. `src/lib/dashboard.ts` (MODIFY)

Change `showDashboard()`:

```ts
import { isatty } from 'node:tty';

export async function showDashboard(): Promise<number | null> {
  if (!git.tryRun('rev-parse', '--show-toplevel').ok) return null;

  const state = loadAndRefreshState();
  if (Object.keys(state.stacks).length === 0) return null;

  // Interactive mode when TTY
  if (isatty(0)) {
    const { showInteractiveGraph } = await import('./interactive-graph.js');
    return showInteractiveGraph();
  }

  // Non-TTY: existing static dashboard
  // ... (current code stays as showStaticDashboard)
}
```

Replace `fetchAllPrStatuses` with import from `pr-status.ts`.

### 4. `src/commands/graph.ts` (MODIFY)

- Export `buildGraph()`, `buildStackNode()`, `collectChain()`, `filterNodes()`, and the `GraphRoot` interface so `interactive-graph.ts` can use them
- Replace the private `fetchAllPrStatuses` method with import from `pr-status.ts`
- `GraphCommand` continues to work exactly as before

### 5. `src/lib/ui.ts` (MINOR CHANGE)

Export the tree-drawing constants that are currently module-private:

```ts
export const DOT_TRUNK = '◇';
export const DOT_STACK = '●';
export const DOT_BRANCH = '○';
export const DOT_CURRENT = '◉';
export const PIPE = '│';
export const FORK_MID = '├';
export const FORK_END = '╰';
export const DASH = '─';
```

No logic changes.

### 6. `src/commands/graph.ts` (MODIFY — optional, follow-up)

Add `--interactive` / `-i` flag so `st graph -i` also launches the interactive view. Low priority.

## Implementation Steps

### Step 1: Extract `fetchAllPrStatuses` to `src/lib/pr-status.ts`
- Move the standalone `fetchAllPrStatuses` from `dashboard.ts` to a new `src/lib/pr-status.ts`
- Update `dashboard.ts` to import it
- Update `graph.ts` to import it (replace the private class method `fetchAllPrStatuses` with a call to the shared function)
- Verify both `st` and `st graph` still work

### Step 2: Export graph constants from `src/lib/ui.ts`
- Change `const` to `export const` for: `DOT_TRUNK`, `DOT_STACK`, `DOT_BRANCH`, `DOT_CURRENT`, `PIPE`, `FORK_MID`, `FORK_END`, `DASH`
- No logic changes

### Step 3: Export graph builders from `src/commands/graph.ts`
- Export `buildGraph()`, `buildStackNode()`, `collectChain()`, `filterNodes()`
- Export the `GraphRoot` interface (currently module-private, needed as return type of `buildGraph`)
- `GraphCommand` continues to use them internally — no behavior change

### Step 4: Create `src/lib/interactive-graph.ts`

#### 4a: `flattenGraphToLines(roots, currentBranch)`
- Walk `GraphStackNode[]` tree (same structure as `renderStackGraph`)
- Emit legend line (non-selectable), blank line (non-selectable)
- For each trunk root: emit trunk line `◇ main` (non-selectable), pipe line (non-selectable)
- For each stack in root: emit stack connector line (non-selectable)
- For each branch in expanded stack: emit branch line (selectable, with `branchName`, `stackName`, `pr`, `isCurrent`)
- Emit blank separator lines between roots (non-selectable)
- Emit footer line with keybinding hints (non-selectable)
- **Every visual line including blanks must have exactly one `GraphLine` entry** — this is critical for the cursor-up re-render math

#### 4b: `interactiveGraphSelect(lines, initialIndex)`
- Accept `GraphLine[]` and initial selectable index
- Use `readline.createInterface` + `readline.emitKeypressEvents` for cross-runtime key handling
- Guard `setRawMode` with `if (process.stdin.setRawMode)` for safety
- Build `selectableIndices` array from lines
- Render loop: write all lines to stderr, highlight selected line
- Keypress handler:
  - Arrow up / `k`: find previous selectable index, re-render
  - Arrow down / `j`: find next selectable index, re-render
  - Enter: resolve with `{ action: 'checkout', branchName }`
  - `o`: resolve with `{ action: 'open', pr }`
  - `q` / Escape / Ctrl-C: resolve with `{ action: 'quit' }`
- Cleanup on resolve: `setRawMode(false)`, close readline, `stdin.pause()`

#### 4c: `showInteractiveGraph()`
- `loadAndRefreshState()`, `findActiveStack(state)` to get position
- Determine `currentStackName`: from `position?.stackName` or fallback to `state.currentStack`
- Determine `currentBranchName`: from `position?.branch.name` or `null`
- `fetchAllPrStatuses(state)` from `pr-status.ts`
- Call `buildGraph(state, currentStackName, currentBranchName, prStatuses, true)` — **`true` for `expandAll` is critical**, otherwise non-current stacks have `branches: undefined`
- Call `flattenGraphToLines(roots, currentBranchName)`
- Find initial cursor index: the line where `isCurrent === true`, or first selectable line
- Call `interactiveGraphSelect(lines, initialIndex)`
- Execute action:
  - **checkout**: Auto-stash dirty worktree (pattern from `default.ts:46-53`), `git.checkout(branchName)`, stash pop, print success + position report
  - **open**: `gh.run('pr', 'view', '--web', '-R', repo, String(pr))` or similar
  - **quit**: return 0

### Step 5: Wire up in `dashboard.ts`
- Gate on `isatty(0)` from `node:tty` (NOT `process.stdin.isTTY` — unreliable in Bun)
- Interactive path: `return showInteractiveGraph()`
- Non-interactive path: existing static dashboard code (rename to `showStaticDashboard()` or just keep in else branch)

### Step 6: Verify
- `st` in TTY shows interactive graph
- `st | cat` shows static dashboard
- `st graph` still works (static, non-interactive)
- `st graph --expand` still works
- Checkout via interactive graph works with dirty worktree (auto-stash)

## Edge Cases

1. **No stacks** — Return `null` from `showDashboard()` as today; cli.ts shows first-run guide
2. **Single stack, single branch** — Works fine, just one selectable line. Still useful to see status.
3. **Not on any stack branch** — Use `state.currentStack` as fallback to determine which stack to highlight. Cursor starts at first branch of that stack, or first branch of first stack if `currentStack` is also null.
4. **Terminal too small** — If graph exceeds terminal height, the ANSI cursor-up approach still works (terminal scrolls). Future enhancement: add scrolling viewport.
5. **Restack in progress** — Show warning line above graph (like current dashboard does)
6. **Dirty worktree on checkout** — Auto-stash pattern from `default.ts:46-53`: `git.stashPush({ includeUntracked: true, message: 'stack-auto-stash' })`, checkout, `git.tryRun('stash', 'pop')` with warning on failure
7. **PR fetch fails** — Graceful degradation: show branches without PR status (same as current graph behavior)
8. **setRawMode not available** — Guard with `if (process.stdin.setRawMode)`. If raw mode isn't available, fall back to static dashboard.

## Non-goals (future work)

- Scrollable viewport for very large graphs (terminal scrollback handles it for now)
- Action submenu (submit, sync, merge from within the graph)
- Stack-level actions (collapse/expand, delete stack)
- `st graph -i` flag (trivial follow-up)
- Mouse support

## Testing

- `st submit --dry-run` to verify no regressions
- Manual testing: run `st` in repos with single stack, multi-stack, dependent stacks, no stacks
- Verify non-TTY fallback: `st | cat` should show static dashboard
- Verify checkout works, PR open works, quit is clean
- Verify auto-stash works on dirty worktree checkout
