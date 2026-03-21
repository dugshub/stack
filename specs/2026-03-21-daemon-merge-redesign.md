# Daemon & Merge Redesign

**Date:** 2026-03-21
**Status:** Ready

## Problem

The current daemon is an overbuilt merge orchestrator (~1,500 lines across 13 files in `src/server/`). It runs a full HTTP server with a state machine engine, job system, SSE streaming, bare git clone management, and Cloudflare tunnel — all to solve what is fundamentally a simple loop: merge PR, sync, submit, repeat.

The merge command (`src/commands/merge.ts`) is 900+ lines with TUI rendering, SSE client logic, pre-restack, job creation, and reconnection handling.

## Design

### Core Principle

The daemon doesn't orchestrate merges via a state machine. The cascade is **emergent**: each webhook trigger does one sync+submit+enable-auto-merge cycle. GitHub's auto-merge handles the timing. The loop runs itself through GitHub events.

### Architecture

**Daemon (slim)** — stays as an HTTP server but with three focused responsibilities:
1. **Webhook receiver -> sync + submit**: When a PR merges, find the affected stack, rebase remaining branches (using bare clone + temp worktrees), push, retarget PRs, enable auto-merge on the next unmerged PR.
2. **Stack checks**: Post `stack/rebase-status` and `stack/merge-ready` commit statuses on push events (existing logic).
3. **PR cache**: Updated from webhook events, served to CLI (existing logic).

**Merge command (simple)** — four modes:
- `st merge` — enable auto-merge on current branch's PR.
- `st merge --all` — enable auto-merge on bottom PR, attach to daemon log stream, show progress until done. Daemon drives the cascade.
- `st merge --now` — merge current branch immediately via API (must be targeted at trunk, or warns).
- `st merge --dry-run` — show plan (existing).

**Logging** — first-class:
- `st daemon run` — foreground mode, logs to stdout.
- `st daemon start` — background mode, logs to file (existing).
- `st daemon attach` — SSE stream of structured log lines from running daemon. Supports `--stack` filter.
- `st daemon logs -f` — tail log file (existing).

### Competition Avoidance

The CLI sync lock prevents the daemon and local CLI from running sync+submit on the same stack simultaneously:

- **`st merge --all` local fallback** (no daemon): acquires lock file `~/.claude/stacks/locks/<stack>.lock`. The daemon checks this lock before acting.
- **`st merge --all` with daemon**: does NOT lock. The daemon drives the cascade; the CLI is just a viewer attached to the log stream.
- The lock is a **CLI sync lock** — it only gates daemon sync, not the user's intent. Named `CLI_SYNC_LOCK` conceptually.
- Lock has a TTL (5 minutes). If the CLI crashes, the daemon can resume after timeout.

### No-Daemon Fallback

If daemon isn't running, `st merge --all` falls back to a local poll loop:
```
acquire CLI_SYNC_LOCK for this stack
checkout trunk (clean working tree required)
for each PR (bottom to top):
  enable auto-merge
  poll gh pr view every 15-30s until merged
  git fetch, rebase remaining, push, retarget next
run st sync to clean up (delete merged branches, remove stack)
release CLI_SYNC_LOCK
```

### How the Daemon Runs Git Operations

The daemon uses the existing **bare clone + temporary worktree** approach (currently in `clone.ts`). This is the correct architecture because:
- It doesn't conflict with the user's working directory
- It handles branch checkouts independently
- It works for both local and remote server deployments

The daemon's `handlePRMerged` directly calls rebase/push/retarget operations using the bare clone infrastructure — NOT by shelling out to `st sync`/`st submit`. This avoids the working directory context problem entirely.

The operations are:
1. `fetchClone()` — update the bare clone
2. `rebaseInWorktree()` — rebase the next branch onto trunk (drops empty commits from squash)
3. `pushBranch()` — push with force-with-lease
4. `ghAsync('pr', 'edit', ...)` — retarget PR to trunk
5. `ghAsync('pr', 'merge', '--auto', '--squash', ...)` — enable auto-merge on next PR
6. Post stack navigation comments via `ghAsync`

## Files to Delete

| File | Reason |
|------|--------|
| `src/server/engine.ts` | State machine replaced by direct operations in webhook handler |
| `src/server/actions.ts` | Action executor replaced by direct operations |
| `src/server/state.ts` | Merge job persistence — no more jobs |
| `src/lib/merge-poller.ts` | Client-side check polling — replaced by daemon attach |
| `src/lib/merge-display.ts` | TUI rendering — replaced by simpler log-based display |

## Files to Keep (Renamed)

| File | New Name | Reason |
|------|----------|--------|
| `src/server/clone.ts` | (keep as-is) | Bare clone + worktree rebase is the right approach for daemon git ops |

## Files to Slim Down (Not Delete)

| File | Changes |
|------|---------|
| `src/server/types.ts` | Delete `MergeJob`, `MergeStep`, `StepStatus`, `JobStatus`, `EngineAction`. Keep `WebhookEvent`, `DaemonConfig`, `TunnelConfig`. Add `StackLock`, `LogEntry`. |
| `src/lib/daemon-client.ts` | Keep `loadDaemonToken()` and `tryDaemonCache()`. Delete `daemonFetch()` (inline where needed). Rename to `src/lib/daemon.ts`. |

## Files to Rewrite

### `src/server/index.ts` — Slim Daemon Server

**Keep:**
- Health endpoint (`/health`)
- Webhook endpoint (`/webhooks/github`) — but new handler logic
- Auth (bearer token)
- Cache API (`/api/cache/...`)
- Status API (`/api/status`) — replace `activeJobs` with `activeLocks`
- Repo registration (`/api/repos`)
- Cache update from webhooks (`updateCacheFromWebhook`)
- Tunnel startup, graceful shutdown

**Add:**
- `POST /api/stacks/:name/lock` — acquire CLI sync lock (with TTL)
- `DELETE /api/stacks/:name/lock` — release CLI sync lock
- `GET /api/locks` — list active locks (for status display)
- `GET /api/logs` — SSE stream of daemon log lines (for `st daemon attach`)
- `GET /api/logs?stack=<name>` — filtered log stream
- Handle `auto_merge_disabled` webhook events — log error when cascade stalls
- Structured logging via `src/server/log.ts`

**Remove:**
- Job CRUD API (`/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/events`)
- SSE streaming for jobs (`sseClients`, `pushSSE`)
- `handleCreateJob`, `handleGetJob`, `handleListJobs`, `handleSSE`
- `processEvent` / engine dispatch
- `executeActions` dispatch

**New webhook handler for `pr_merged`:**
```typescript
async function handlePRMerged(repo: string, prNumber: number): Promise<void> {
  // loadStackStateForRepo and findStackForPR are exported from stack-checks.ts
  const state = loadStackStateForRepo(repo);
  if (!state) return;

  const found = findStackForPR(state, prNumber);
  if (!found) return;
  const { stackName, stack, branchIndex } = found;

  // Check CLI sync lock
  if (isStackLocked(stackName)) {
    log('info', `Stack "${stackName}" locked by CLI — skipping sync`, stackName);
    return;
  }

  log('info', `PR #${prNumber} merged in stack "${stackName}" — cascading...`, stackName);

  // Find remaining unmerged branches after this one
  const remaining = stack.branches.slice(branchIndex + 1);
  if (remaining.length === 0) {
    log('success', `Stack "${stackName}" fully merged`, stackName);
    return;
  }

  const nextBranch = remaining[0];
  if (!nextBranch || !nextBranch.pr) return;

  // Get the merged branch's tip for rebase exclusion
  const mergedBranch = stack.branches[branchIndex];
  const oldBase = mergedBranch?.tip;
  if (!oldBase) {
    log('error', `Missing branch tip for rebase — cannot cascade`, stackName);
    return;
  }

  // Rebase next branch onto trunk using bare clone
  const clonePath = await ensureClone(repoUrl(repo), repoName(repo));
  await fetchClone(clonePath);

  const preSha = await getBranchSha(clonePath, nextBranch.name);
  const rebaseResult = await rebaseInWorktree(clonePath, {
    branch: nextBranch.name,
    onto: stack.trunk,
    oldBase,
  });
  if (!rebaseResult.ok) {
    log('error', `Rebase failed for ${nextBranch.name}: ${rebaseResult.error}`, stackName);
    return;
  }

  const pushResult = await pushBranch(clonePath, nextBranch.name, preSha);
  if (!pushResult.ok) {
    log('error', `Push failed for ${nextBranch.name}: ${pushResult.error}`, stackName);
    return;
  }

  // Post rebase-status check
  const newSha = await getBranchSha(clonePath, nextBranch.name);
  await ghAsync('api', `repos/${repo}/statuses/${newSha}`,
    '-f', 'state=success', '-f', 'context=stack/rebase-status',
    '-f', `description=Rebased on ${stack.trunk}`);

  // Retarget PR to trunk
  await ghAsync('pr', 'edit', String(nextBranch.pr), '--base', stack.trunk);
  log('info', `Retargeted #${nextBranch.pr} to ${stack.trunk}`, stackName);

  // Enable auto-merge on next PR
  const mergeResult = await ghAsync('pr', 'merge', String(nextBranch.pr), '--auto', '--squash');
  if (mergeResult.ok) {
    log('success', `Auto-merge enabled on #${nextBranch.pr}`, stackName);
  } else {
    log('error', `Failed to enable auto-merge on #${nextBranch.pr}: ${mergeResult.stderr}`, stackName);
  }
}
```

**New handler for `auto_merge_disabled`:**
```typescript
async function handleAutoMergeDisabled(repo: string, prNumber: number, reason: string): Promise<void> {
  const state = loadStackStateForRepo(repo);
  if (!state) return;

  const found = findStackForPR(state, prNumber);
  if (!found) return;

  log('error',
    `Auto-merge disabled on #${prNumber}: ${reason} — cascade stalled. Run \`st merge --all\` to restart.`,
    found.stackName);
}
```

### `src/server/stack-checks.ts` — Export Shared Helpers

Export `loadStackStateForRepo` so `index.ts` can use it. Add and export `findStackForPR`:

```typescript
export function findStackForPR(
  state: StackFile,
  prNumber: number,
): { stackName: string; stack: StackFile['stacks'][string]; branchIndex: number } | null {
  for (const [stackName, stack] of Object.entries(state.stacks)) {
    for (let i = 0; i < stack.branches.length; i++) {
      if (stack.branches[i]?.pr === prNumber) {
        return { stackName, stack, branchIndex: i };
      }
    }
  }
  return null;
}
```

### `src/server/webhook.ts` — Keep As-Is

No changes needed. Already parses `pr_merged`, `pr_closed`, `auto_merge_disabled`, and `push` events.

### `src/server/cache.ts` — Keep As-Is

### `src/server/tunnel.ts` — Keep As-Is

### `src/server/webhook-manager.ts` — Keep As-Is

### `src/server/clone.ts` — Keep As-Is

Bare clone + temporary worktree approach is correct. Used by both the new `handlePRMerged` and the existing `stack-checks.ts`.

### `src/server/spawn.ts` — Keep As-Is

Already has `ghAsync` and `gitAsync` which are all the daemon needs.

### `src/server/lifecycle.ts` — Minor Changes

- Keep all existing functions.
- Replace `activeJobs` in `DaemonStatusInfo` with `activeLocks: number`.
- Remove `activeJobs` computation from status endpoint.

### `src/commands/daemon.ts` — Add `run` and `attach`

**Keep:** `start`, `stop`, `status`, `logs`

**Add:**
- `run` — start server in foreground (import and call `startServer()` directly, don't fork). Set `setForeground(true)` so logs go to stdout.
- `attach` — connect to `GET /api/logs` SSE endpoint (with optional `--stack` filter), stream formatted log lines to terminal. Ctrl-C disconnects.

**Fold `setup` into first `start`/`run`:** If no config file exists, auto-generate webhook secret and detect tunnel config (existing setup logic).

### `src/commands/merge.ts` — Complete Rewrite (~250 lines)

```typescript
export class MergeCommand extends Command {
  static override paths = [['stack', 'merge'], ['merge']];

  all = Option.Boolean('--all', false);
  now = Option.Boolean('--now', false);
  dryRun = Option.Boolean('--dry-run', false);
  abort = Option.Boolean('--abort', false);
  stackOpt = Option.String('--stack,-s');

  async execute(): Promise<number> {
    if (this.dryRun) return this.showDryRun();
    if (this.now) return this.mergeNow();
    if (this.all) return this.mergeAll();
    return this.mergeCurrent();
  }

  // st merge — enable auto-merge on current branch's PR
  private mergeCurrent(): number {
    const state = loadAndRefreshState();
    const resolved = resolveStack({ state });
    const { stack, position } = resolved;
    if (!position) { ui.error('Not on a stack branch'); return 2; }
    const branch = stack.branches[position.index];
    if (!branch?.pr) { ui.error('No PR for current branch. Run st submit first.'); return 2; }
    gh.run('pr', 'merge', String(branch.pr), '--auto', '--squash');
    ui.success(`Auto-merge enabled on #${branch.pr}`);
    return 0;
  }

  // st merge --now — merge immediately (PR must be targeted at trunk)
  private mergeNow(): number {
    const state = loadAndRefreshState();
    const resolved = resolveStack({ state });
    const { stack, position } = resolved;
    if (!position) { ui.error('Not on a stack branch'); return 2; }
    const branch = stack.branches[position.index];
    if (!branch?.pr) { ui.error('No PR for current branch.'); return 2; }

    // Warn if not targeted at trunk (i.e., not the bottom PR)
    if (position.index > 0) {
      ui.warn(`PR #${branch.pr} is not the bottom of the stack. It may fail if targeted at a branch PR.`);
    }

    const result = gh.tryRun('pr', 'merge', String(branch.pr), '--squash');
    if (!result.ok) {
      ui.error(`Merge failed: ${result.stderr}`);
      return 2;
    }
    ui.success(`Merged #${branch.pr}`);
    return 0;
  }

  // st merge --all — merge entire stack
  private async mergeAll(): Promise<number> {
    const state = loadAndRefreshState();
    const resolved = resolveStack({ state, explicitName: this.stackOpt });
    const { stackName, stack } = resolved;

    // Validate
    const branchesWithPR = stack.branches.filter(b => b.pr != null);
    if (branchesWithPR.length === 0) {
      ui.error('No PRs found. Run st submit first.');
      return 2;
    }
    const branchesWithoutPR = stack.branches.filter(b => b.pr == null);
    if (branchesWithoutPR.length > 0) {
      ui.error(`Branches without PRs: ${branchesWithoutPR.map(b => b.name).join(', ')}. Run st submit.`);
      return 2;
    }

    // Filter out already-merged PRs
    const prStatuses = gh.prViewBatch(branchesWithPR.map(b => b.pr!));
    const unmerged = branchesWithPR.filter(b => {
      const s = prStatuses.get(b.pr!);
      if (s?.state === 'MERGED') { ui.success(`#${b.pr} already merged`); return false; }
      return true;
    });
    if (unmerged.length === 0) {
      ui.success('All PRs already merged.');
      return 0;
    }

    // Show plan + confirm
    this.showMergePlan(unmerged, stack.trunk);
    if (process.stderr.isTTY) {
      const confirm = await p.confirm({ message: `Merge ${unmerged.length} PRs?` });
      if (p.isCancel(confirm) || !confirm) return 0;
    }

    // Enable auto-merge on first unmerged PR
    const first = unmerged[0]!;
    const mergeResult = gh.tryRun('pr', 'merge', String(first.pr), '--auto', '--squash');
    if (!mergeResult.ok) {
      ui.error(`Failed to enable auto-merge on #${first.pr}: ${mergeResult.stderr}`);
      return 2;
    }
    ui.success(`Auto-merge enabled on #${first.pr}`);

    // If daemon is running: attach to log stream and watch
    if (await isDaemonHealthy()) {
      ui.info('Daemon is running — watching merge cascade...');
      return this.streamDaemonLogs(stackName, state, stack);
    }

    // Fallback: local poll loop
    ui.info('No daemon — running merge loop locally...');
    return this.mergeLocal(stackName, state, stack, unmerged);
  }

  private async streamDaemonLogs(stackName, state, stack): Promise<number> {
    // Connect to GET /api/logs?stack=<name> SSE endpoint
    // Display formatted log lines
    // When "fully merged" log entry arrives, run cleanup and return 0
    // On disconnect/timeout, suggest st merge --status or re-run
    // ... (implementation details)

    // After cascade completes, cleanup
    this.cleanupLocal(state, stackName, stack);
    return 0;
  }

  private async mergeLocal(stackName, state, stack, unmerged): Promise<number> {
    // Acquire CLI sync lock (prevents daemon from competing)
    await this.acquireLock(stackName);

    try {
      // First PR already has auto-merge enabled (done in mergeAll)
      for (let i = 0; i < unmerged.length; i++) {
        const branch = unmerged[i]!;

        // Poll until merged
        while (true) {
          await sleep(15_000);
          const status = gh.prView(branch.pr!);
          if (status?.state === 'MERGED') break;
          // TODO: show check progress while waiting
        }
        ui.success(`#${branch.pr} merged`);

        // If there's a next PR, sync + enable auto-merge
        const next = unmerged[i + 1];
        if (next) {
          // Sync: fetch, rebase remaining onto trunk, push
          git.fetch();
          // ... rebase logic (similar to sync command) ...

          // Retarget + enable auto-merge on next
          gh.run('pr', 'edit', String(next.pr), '--base', stack.trunk);
          gh.run('pr', 'merge', String(next.pr), '--auto', '--squash');
          ui.success(`Auto-merge enabled on #${next.pr}`);
        }
      }
    } finally {
      await this.releaseLock(stackName);
    }

    // Cleanup
    this.cleanupLocal(state, stackName, stack);
    return 0;
  }

  private cleanupLocal(state, stackName, stack): void {
    // Delete local branches
    for (const branch of stack.branches) {
      git.tryRun('branch', '-d', branch.name);
    }
    // Remove stack from state
    delete state.stacks[stackName];
    if (state.currentStack === stackName) state.currentStack = null;
    saveState(state);
    // Checkout trunk
    try {
      git.checkout(stack.trunk);
      git.tryRun('pull', '--ff-only');
    } catch { /* non-fatal */ }
    ui.success(`Stack "${stackName}" cleaned up`);
  }

  private showDryRun(): number { /* keep existing logic */ }
  private showMergePlan(branches, trunk): void { /* display plan */ }
}
```

### `src/server/types.ts` — Slim Down

Delete: `MergeJob`, `MergeStep`, `StepStatus`, `JobStatus`, `EngineAction`

Keep: `WebhookEvent`, `DaemonConfig`, `TunnelConfig`, `MergeStrategy`

Add:
```typescript
export interface StackLock {
  stackName: string;
  acquiredAt: string;
  expiresAt: string;  // TTL-based expiry (5 min default)
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warn';
  message: string;
  stack?: string;  // optional: for filtering
}
```

### New file: `src/server/log.ts` — Structured Logging

```typescript
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LogEntry } from './types.js';

const logClients = new Set<WritableStreamDefaultWriter>();
const LOG_FILE = join(homedir(), '.claude', 'stacks', 'daemon.log');
let foreground = false;

export function setForeground(fg: boolean): void { foreground = fg; }

export function log(level: LogEntry['level'], message: string, stack?: string): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level, message, stack,
  };

  // Always write to log file
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

  // Foreground mode: also write to stdout
  if (foreground) {
    const prefix = { info: ' ', success: '+', error: '!', warn: '?' }[level];
    process.stdout.write(`[${prefix}] ${message}\n`);
  }

  // Push to SSE clients
  const sseData = `data: ${JSON.stringify(entry)}\n\n`;
  for (const writer of logClients) {
    writer.write(new TextEncoder().encode(sseData)).catch(() => {
      logClients.delete(writer);
    });
  }
}

export function addLogClient(writer: WritableStreamDefaultWriter): void {
  logClients.add(writer);
}

export function removeLogClient(writer: WritableStreamDefaultWriter): void {
  logClients.delete(writer);
}
```

### New file: `src/server/locks.ts` — Stack Lock Management

```typescript
import type { StackLock } from './types.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const locks = new Map<string, StackLock>();

export function acquireLock(stackName: string, ttlMs = DEFAULT_TTL_MS): boolean {
  // Check for expired locks
  const existing = locks.get(stackName);
  if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
    return false; // Already locked
  }

  locks.set(stackName, {
    stackName,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  return true;
}

export function releaseLock(stackName: string): void {
  locks.delete(stackName);
}

export function isStackLocked(stackName: string): boolean {
  const lock = locks.get(stackName);
  if (!lock) return false;
  if (new Date(lock.expiresAt).getTime() <= Date.now()) {
    locks.delete(stackName);
    return false;
  }
  return true;
}

export function activeLockCount(): number {
  // Prune expired
  for (const [name, lock] of locks) {
    if (new Date(lock.expiresAt).getTime() <= Date.now()) {
      locks.delete(name);
    }
  }
  return locks.size;
}
```

## Changes to `src/cli.ts`

- Keep auto-start daemon logic but simplify: remove the fire-and-forget repo registration on every command (lines 151-176). Repo registration happens on `st daemon setup` or first merge.
- The `ensureDaemon()` call stays for cache benefits.

## Changes to `src/commands/sync.ts`

- Remove the `findActiveJobForStack` guard (lines 12, 29-46). The lock system handles competition, and users should be able to run `st sync` manually anytime.

## Changes to `src/lib/daemon-client.ts` -> `src/lib/daemon.ts`

- Rename file.
- Keep `loadDaemonToken()` and `tryDaemonCache()`.
- Add `daemonFetch(path, opts?)` — simple fetch wrapper with auth.
- Remove the old `daemonFetch` that had a 200ms timeout (too aggressive).
- Update all imports across the codebase.

## Behavior Change Notes

### `st merge` (no flags) — NEW BEHAVIOR
Previously printed an error requiring `--all`. Now enables auto-merge on the current branch's PR. This is intentional — single-PR merge is a useful, common operation. No confirmation prompt needed since auto-merge is non-destructive (GitHub merges when CI passes, can be cancelled).

### `st merge --now` — guard for non-bottom PRs
If the current branch is not the bottom of the stack (index > 0), warn the user that the PR may be targeted at another branch PR, not trunk. GitHub will reject the merge in that case.

## Implementation Order

### Step 1: New logging system
- Create `src/server/log.ts`
- Wire into `src/server/index.ts` (replace all `console.log` calls with `log()`)
- Add `GET /api/logs` SSE endpoint to `index.ts`
- Add `run` and `attach` subcommands to `src/commands/daemon.ts`

### Step 2: Stack lock system
- Create `src/server/locks.ts`
- Add `POST/DELETE /api/stacks/:name/lock` endpoints to `index.ts`
- Add `GET /api/locks` endpoint

### Step 3: Export helpers from stack-checks.ts
- Export `loadStackStateForRepo`
- Add and export `findStackForPR`

### Step 4: Daemon webhook handler rewrite
- Add `handlePRMerged` to `index.ts` — uses bare clone (clone.ts) for rebase+push, ghAsync for retarget+auto-merge
- Add `handleAutoMergeDisabled` to `index.ts` — logs error about stalled cascade
- Remove engine dispatch, job creation, SSE job streaming from webhook handler
- Delete `engine.ts`, `actions.ts`, `state.ts` (job persistence)

### Step 5: Merge command rewrite
- Rewrite `src/commands/merge.ts` (~250 lines)
- `st merge` — enable auto-merge on current branch
- `st merge --now` — merge immediately (with non-bottom warning)
- `st merge --all` — daemon attach or local fallback
- `st merge --dry-run` — keep existing plan display
- Include `cleanupLocal` for post-merge cleanup

### Step 6: Clean up
- Slim `src/server/types.ts` (remove job types, add lock/log types)
- Rename `src/lib/daemon-client.ts` -> `src/lib/daemon.ts`, update imports
- Simplify `src/cli.ts` auto-start (remove per-command repo registration)
- Remove `findActiveJobForStack` guard from `src/commands/sync.ts`
- Delete `src/lib/merge-poller.ts`, `src/lib/merge-display.ts`

### Step 7: Verify
- `st merge --dry-run` works
- `st merge` enables auto-merge on current branch
- `st merge --now` merges immediately with warning for non-bottom
- `st daemon run` starts in foreground with structured logs
- `st daemon attach` streams logs (with `--stack` filter)
- Webhook `pr_merged` -> daemon rebases+pushes+retargets+enables auto-merge
- Webhook `auto_merge_disabled` -> daemon logs error about stalled cascade
- `st merge --all` with daemon: enables auto-merge, attaches to logs, shows progress
- `st merge --all` without daemon: poll loop with local sync works
- CLI sync lock prevents daemon+CLI competition in local mode

## Line Count Estimate

| Before | After |
|--------|-------|
| `server/` ~1,500 lines (13 files) | `server/` ~600 lines (11 files) |
| `merge.ts` ~900 lines | `merge.ts` ~250 lines |
| `merge-display.ts` 145 lines | deleted |
| `merge-poller.ts` 170 lines | deleted |
| `daemon-client.ts` 74 lines | `daemon.ts` ~50 lines |
| **~2,800 lines** | **~900 lines** |

Net deletion: ~1,900 lines.
New files: `log.ts` (~40 lines), `locks.ts` (~40 lines) = +80 lines.
**Net: ~1,800 lines removed.**
