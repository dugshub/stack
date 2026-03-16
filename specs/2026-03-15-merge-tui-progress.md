# Merge TUI Progress Display

## Problem

During `stack merge --all`, the user sees minimal output — just SSE event messages with long silences between PR merges. No visibility into CI check progress, rebase status, or elapsed time.

## Solution

A live-updating TUI that shows the full merge pipeline: each PR's state, individual check statuses on the active PR, rebase progress, and elapsed time. Uses ANSI escape codes to redraw in-place.

## Design

### Target output

```
  Merging stack: merge
  ──────────────────────────────────

  #18  1-gh-additions        ✓ merged (12s)
  #19  2-server-foundation   ✓ merged (48s)
  #20  3-server-engine       ⏳ merging...
       ├─ claude-review      ✓ passed
       └─ ci/build           ◷ running (42s)
  #21  4-server-http         ○ pending
  #22  5-merge-command       ○ pending
  #23  6-cli-wiring          ○ pending

  ↻ Rebasing #21 onto main...     (shown during rebase phase)

  Elapsed: 3m 22s
```

### Architecture — three layers

#### 1. `src/lib/merge-display.ts` — Pure rendering primitive

A stateless renderer that takes a display model and produces the TUI output. This is the reusable primitive — no network, no polling, no side effects.

```typescript
export interface CheckStatus {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | null;
  startedAt?: string;
}

export interface StepDisplay {
  prNumber: number;
  branchShort: string;  // last segment of branch name
  state: 'pending' | 'checks-running' | 'auto-merge-enabled' | 'merging' | 'merged' | 'rebasing' | 'failed';
  checks?: CheckStatus[];
  elapsed?: number;      // ms since this step became active
  error?: string;
}

export interface MergeDisplay {
  stackName: string;
  steps: StepDisplay[];
  activeMessage?: string;  // e.g. "Rebasing #21 onto main..."
  totalElapsed: number;    // ms since merge started
}

/** Render the display model to a string (no ANSI cursor movement — just the frame). */
export function renderMergeDisplay(display: MergeDisplay): string;

/** Return the number of lines in the last render (for cursor rewind). */
export function lineCount(rendered: string): number;
```

#### 2. `src/lib/merge-poller.ts` — Check status polling

Polls GitHub GraphQL for status checks on the active PR. Reuses the `gh api graphql` pattern from `graphql.ts`.

```typescript
/** Fetch status checks for a single PR. */
export function fetchCheckStatus(owner: string, repo: string, prNumber: number): CheckStatus[];
```

Query shape:
```graphql
query {
  repository(owner: "...", name: "...") {
    pullRequest(number: N) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  ... on CheckRun { name status conclusion startedAt }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Map `StatusContext` → `CheckStatus` by converting `state` (PENDING/SUCCESS/FAILURE/ERROR) to the CheckStatus shape.

#### 3. Integration in `src/commands/merge.ts` — `streamEvents()` updates

Replace the current simple `ui.info()`/`ui.success()` SSE handler with the TUI renderer:

- **On start**: Initialize `MergeDisplay` from job steps, render initial frame
- **Start poll interval**: Every 5s, call `fetchCheckStatus()` on the active step's PR, update `MergeDisplay.steps[activeIndex].checks`, re-render
- **On SSE `notify` event**: Update step states (merged, rebasing, failed), re-render
- **On SSE `done` event**: Final render, clear interval, show summary
- **ANSI rewind**: Before each re-render, move cursor up by `lineCount(previousRender)` lines using `\x1b[${n}A\x1b[J`

Non-TTY fallback: if `!process.stderr.isTTY`, fall back to the current simple log-line behavior.

### Rebase visibility

The server engine already emits notify events during rebase (`"#18 merged. Rebasing #19..."`). Parse these in `streamEvents()` to set `activeMessage` on the display model. The message clears when the next step transitions to `checks-running` or `auto-merge-enabled`.

### Elapsed time

- `totalElapsed`: `Date.now() - mergeStartTime`
- Per-step `elapsed`: tracked when a step becomes active (transitions from pending)
- Format as `Xs`, `Xm Ys`, or `Xh Ym`

## Files to create

- `src/lib/merge-display.ts` — renderer (~80 lines)
- `src/lib/merge-poller.ts` — check status fetcher (~50 lines)

## Files to modify

- `src/commands/merge.ts` — update `streamEvents()` to use the TUI renderer (~60 lines changed)

## Scope

~200 lines of new code. No new dependencies — uses existing `theme` for colors, `gh api graphql` for polling, ANSI escapes for cursor control.

## Verification

1. `bunx tsc --noEmit` — type check
2. Manual test: run `stack merge --dry-run` to verify plan display still works
3. Full test: run `stack merge --all` on a test stack and observe the live TUI
