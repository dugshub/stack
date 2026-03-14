# Graceful Argument Defaults

**Goal:** When a user runs a command without required arguments (e.g. `stack nav`), show helpful guidance instead of a clipanion error. Every command should be safe to invoke bare.

## Analysis

| Command | Current behavior (bare) | Needs fix? |
|---------|------------------------|------------|
| `status` | Works fine | No |
| `nav` | Clipanion error: missing positional arg | **Yes** |
| `create` | Works (auto-detect mode) | No |
| `push` | Works (auto-detect stack) | No |
| `restack` | Works (default mode) | No |
| `submit` | Works (uses current branch) | No |
| `sync` | Works (uses current branch) | No |

**Only `nav` has a hard-required positional arg.** The other commands already handle bare invocation gracefully.

## Changes

### 1. `src/commands/nav.ts` — Make direction optional, show usage when missing

**Change:** Make `direction` optional (`required: false`). When called without a direction, show the current position in the stack plus available navigation directions.

```typescript
// Before:
direction = Option.String({ required: true });

// After:
direction = Option.String({ required: false });
```

Then at the top of `execute()`, if `this.direction` is undefined, show a helpful interactive-style message:

```
Stack: my-feature (branch 2 of 3)

  Navigate with:
    stack nav up       Move toward trunk
    stack nav down     Move away from trunk
    stack nav top      Go to top of stack
    stack nav bottom   Go to bottom of stack
```

If not on a stack branch, show:

```
  Navigate your stack:
    stack nav up       Move toward trunk
    stack nav down     Move away from trunk
    stack nav top      Go to top of stack
    stack nav bottom   Go to bottom of stack

  Not currently on a stack branch.
  Use `stack status` to see tracked stacks.
```

**Implementation:**

- Make `direction` optional
- Add a private `showUsage()` method that:
  1. Tries to load state and find active stack
  2. If on a stack: show position report + direction options
  3. If not on a stack: show direction options + hint
- Return exit code `0` (not an error — user just needs guidance)

### Files to modify

1. `src/commands/nav.ts` — the only file that needs changes

## Non-goals

- Don't change the error messages for invalid directions (e.g. `stack nav sideways`) — those should stay as errors
- Don't add interactive prompts or menus — just show helpful text
- Don't modify any other commands — they already handle bare invocation well
