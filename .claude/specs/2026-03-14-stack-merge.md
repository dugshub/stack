# Stack Merge — Webhook-Driven Merge Orchestrator

## Goal

A webhook server that merges stacked PRs bottom-up, reacting to GitHub events in real-time. Graphite's "Merge N" as a service.

## Context

Today we have `sync` (reactive — cleans up after merges happen on GitHub) but no way to *initiate* merges. Users must click merge on GitHub, come back, run `stack sync`, repeat for each PR.

**Prerequisite**: Repository must have branch protection rules with required status checks enabled. GitHub's auto-merge API requires this.

Existing code we'll reuse/extend:
- `src/lib/gh.ts` — GitHub CLI wrapper
- `src/lib/graphql.ts` — Batch GraphQL reads
- `src/lib/state.ts` — Atomic JSON state persistence
- `src/lib/types.ts` — Core types
- `src/commands/sync.ts` — Post-merge sync logic (retarget, rebase, delete)

## Architecture

### It's a Server

The merge orchestrator is a Bun HTTP server that receives GitHub webhooks. No polling. Events arrive, state transitions happen, actions fire.

```
GitHub ──webhook──→ Server ──→ Engine ──→ gh CLI / git (async)
                                  ↕
                            Job State (disk)
```

### The Rebase Problem (Solved)

After squash-merging PR #1, PR #2's branch still has stale commits. Just retargeting the PR base on GitHub is insufficient — we must rebase the actual branch.

**Solution: Server maintains a bare clone for rebasing.**

```
~/.claude/stacks/<repo>.git/    — bare clone, used only by server
```

On job start, the server ensures the bare clone exists (or creates it). After each merge:
1. Fetch latest from origin into the bare clone
2. `git rebase --onto origin/main <old-branch-tip> <next-branch>` in a worktree from the bare clone
3. Force-push the rebased branch to origin
4. Then retarget the PR base + enable auto-merge

This keeps the server fully independent from the user's working tree. No risk of corrupting uncommitted changes.

### Components

```
src/server/index.ts        — Bun.serve HTTP server: routes, webhook verification
src/server/webhook.ts      — Parse + validate GitHub webhook payloads
src/server/engine.ts       — Pure orchestrator: (job, event) → (actions, newJob)
src/server/types.ts        — MergeJob, MergeStep, webhook event types
src/server/state.ts        — Job persistence (atomic writes)
src/server/actions.ts      — Side effects: merge, retarget, rebase, push (all async)
src/server/clone.ts        — Manage the bare clone + worktree for rebasing
src/commands/merge.ts      — CLI: `stack merge` sends request to server
```

### Event Flow (Detailed)

```
1. User runs `stack merge --all`
2. CLI creates MergeJob from stack state, POSTs to server
3. Server stores job, enables auto-merge on bottom PR:
   `gh pr merge --auto --squash #42`
4. GitHub runs CI on #42...
5. CI passes → GitHub merges → fires `pull_request.closed` (merged=true)
6. Server receives webhook → engine transitions #42 to `merged`
7. Server fetches into bare clone, rebases #43 onto origin/main:
   `git rebase --onto origin/main <old-tip-of-42> <branch-43>`
8. Server force-pushes rebased #43 to origin
9. Server retargets #43 base to main: `gh pr edit #43 --base main`
10. Server enables auto-merge: `gh pr merge --auto --squash #43`
11. GitHub runs CI on #43 (now cleanly rebased)...
12. Repeat 5-10 for each PR
13. Last PR merged → delete all branches, update stack state, notify
```

### MergeJob State Machine

Each PR gets a `MergeStep`:

```
pending → auto-merge-enabled → merged → rebasing-next → done
                                  ↓           ↓
                               failed      failed
```

The `rebasing-next` state captures the critical rebase + push + retarget sequence between merges.

Job-level status:

```
running → completed
    ↓
  failed
```

### Webhook Events We Handle

| GitHub Event | Action |
|---|---|
| `pull_request.closed` (merged=true) | Advance step, rebase next, retarget, enable auto-merge |
| `pull_request.closed` (merged=false) | Mark step failed, halt job |
| `pull_request.auto_merge_disabled` | CI failed or conflict — mark step failed, halt job |

We only handle 3 event types. Everything else returns 200 and is ignored.

### API Endpoints

```
POST /api/jobs              — Create a new merge job
GET  /api/jobs/:id          — Get job status
GET  /api/jobs              — List active jobs
GET  /api/jobs/:id/events   — SSE stream of job updates
POST /webhooks/github       — GitHub webhook receiver
GET  /health                — Health check
```

## Plan

### Step 1: Types

- File: `src/server/types.ts`

```typescript
export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export type StepStatus =
  | 'pending'              // not yet processed
  | 'auto-merge-enabled'   // gh pr merge --auto fired, waiting for GitHub
  | 'merged'               // PR merged on GitHub (webhook confirmed)
  | 'rebasing-next'        // rebasing + pushing + retargeting next PR
  | 'done'                 // fully processed
  | 'failed';              // something went wrong

export type JobStatus = 'running' | 'completed' | 'failed';

export interface MergeStep {
  prNumber: number;
  branch: string;
  status: StepStatus;
  error?: string;
  mergedAt?: string;
  /** Stored before merge so we can use it as rebase exclusion point */
  branchTip?: string;
}

export interface MergeJob {
  id: string;
  stackName: string;
  repo: string;           // owner/name
  trunk: string;          // e.g. 'main'
  status: JobStatus;
  strategy: MergeStrategy;
  steps: MergeStep[];
  currentStep: number;
  created: string;
  updated: string;
}

// Parsed webhook events (only what we care about)
export type WebhookEvent =
  | { type: 'pr_merged'; prNumber: number; repo: string }
  | { type: 'pr_closed'; prNumber: number; repo: string }
  | { type: 'auto_merge_disabled'; prNumber: number; repo: string; reason: string };

// Actions the engine emits (executed by actions.ts)
export type EngineAction =
  | { type: 'enable-auto-merge'; prNumber: number; strategy: MergeStrategy }
  | { type: 'rebase-and-push'; branch: string; onto: string; oldBase: string }
  | { type: 'retarget-pr'; prNumber: number; newBase: string }
  | { type: 'delete-branches'; branches: Array<{ name: string; remote: boolean }> }
  | { type: 'notify'; message: string; level: 'info' | 'success' | 'error' };
```

### Step 2: State Persistence

- File: `src/server/state.ts`
- Store at `~/.claude/stacks/merge-jobs.json` (all repos, keyed by job ID)
- Reuse the atomic write pattern from `src/lib/state.ts` — extract `atomicWriteJson(path, data)` into a shared utility
- Functions:
  - `loadAllJobs(): Record<string, MergeJob>`
  - `loadJob(id: string): MergeJob | null`
  - `saveJob(job: MergeJob): void` — saves BEFORE actions execute (crash safety)
  - `findJobForPR(repo: string, prNumber: number): MergeJob | null`
- Job cleanup: jobs with `completed` or `failed` status older than 24h are auto-pruned on load
- **Mutex**: `sync` command must check for active merge jobs and refuse to run. Add a `hasActiveMergeJob(stackName)` check.

### Step 3: Bare Clone Manager

- File: `src/server/clone.ts`
- Manages `~/.claude/stacks/clones/<repo-name>.git` (bare clone)
- Functions:
  - `ensureClone(repoUrl: string, repoName: string): string` — returns path to bare clone, creates if missing
  - `fetchClone(clonePath: string): void` — `git fetch origin` in the bare clone
  - `rebaseInWorktree(clonePath: string, opts: { branch: string; onto: string; oldBase: string }): { ok: boolean; error?: string }` — creates a temp worktree, rebases, cleans up
  - `pushBranch(clonePath: string, branch: string): { ok: boolean; error?: string }` — force-with-lease push
- All git operations use async `Bun.spawn` (not spawnSync) to avoid blocking the event loop

### Step 4: Add GitHub CLI Functions

- File: `src/lib/gh.ts`
- Add:

```typescript
// Enable auto-merge (requires branch protection with required checks)
export function prMergeAuto(prNumber: number, opts: {
  strategy: MergeStrategy;
}): { ok: boolean; error?: string }
// Uses: gh pr merge <number> --auto --squash|--merge|--rebase

// Disable auto-merge
export function prMergeAutoDisable(prNumber: number): { ok: boolean; error?: string }
// Uses: gh pr merge <number> --disable-auto
```

- These use the existing `exec()` pattern (returns `{ok, stdout, stderr}`)
- The action executor in `src/server/actions.ts` wraps these in async calls

### Step 5: Webhook Handler

- File: `src/server/webhook.ts`
- Verify HMAC-SHA256 signature from `X-Hub-Signature-256` header
- Parse `X-GitHub-Event` header to determine event type
- Extract into `WebhookEvent` or return `null` for events we don't care about

```typescript
export function verifySignature(body: string, signature: string, secret: string): boolean
export function parseWebhook(eventType: string, payload: unknown): WebhookEvent | null
```

- `pull_request` event with `action: 'closed'` + `pull_request.merged: true` → `pr_merged`
- `pull_request` event with `action: 'closed'` + `pull_request.merged: false` → `pr_closed`
- `pull_request` event with `action: 'auto_merge_disabled'` → `auto_merge_disabled`
- Everything else → `null`

### Step 6: Engine (Pure Logic)

- File: `src/server/engine.ts`
- Pure function: `(job, event) → { job, actions }`

```typescript
export function processEvent(
  job: MergeJob,
  event: WebhookEvent,
): { job: MergeJob; actions: EngineAction[] }
```

**Logic:**

1. **`pr_merged` for current step's PR:**
   - Mark step `merged`, set `mergedAt`
   - If there's a next step:
     - Mark current step `rebasing-next`
     - Emit `rebase-and-push` action: rebase next branch onto `origin/<trunk>`, excluding current step's `branchTip`
     - Emit `retarget-pr` action: retarget next PR to trunk
     - Emit `enable-auto-merge` on next PR
     - Advance `currentStep`
   - If last step:
     - Emit `delete-branches` for all branches in the job
     - Mark job `completed`

2. **`auto_merge_disabled` for current step's PR:**
   - Mark step `failed` with reason
   - Mark job `failed`
   - Emit `notify` with failure details

3. **`pr_closed` (not merged) for current step's PR:**
   - Mark step `failed` with "PR closed without merging"
   - Mark job `failed`

4. **Event for a PR not in the current step:**
   - Ignore (return unchanged job, no actions)

### Step 7: Action Executor

- File: `src/server/actions.ts`
- Executes `EngineAction[]` sequentially, all async (no blocking)

```typescript
export async function executeActions(
  actions: EngineAction[],
  config: { clonePath: string },
): Promise<Array<{ action: EngineAction; ok: boolean; error?: string }>>
```

- Each action maps to a gh/git call:
  - `enable-auto-merge` → `gh.prMergeAuto()` (with retry: 2 attempts, 3s backoff)
  - `rebase-and-push` → `clone.rebaseInWorktree()` + `clone.pushBranch()`
  - `retarget-pr` → `gh.prEdit()`
  - `delete-branches` → `git.deleteBranch()` for each
  - `notify` → append to SSE stream + log
- If any action fails, log the error and return it. The webhook handler decides whether to mark the job as failed.

### Step 8: HTTP Server

- File: `src/server/index.ts`
- Uses `Bun.serve` (native, zero deps)
- All webhook processing is async — no blocking the event loop
- SSE connections stored in a Map keyed by job ID

```typescript
const sseClients = new Map<string, Set<WritableStreamDefaultWriter>>();

export function startServer(config: ServerConfig): void {
  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/webhooks/github' && req.method === 'POST') {
        return handleWebhook(req, config);
      }
      if (url.pathname === '/api/jobs' && req.method === 'POST') {
        return handleCreateJob(req);
      }
      if (url.pathname.match(/^\/api\/jobs\/[\w-]+$/) && req.method === 'GET') {
        return handleGetJob(req);
      }
      if (url.pathname.match(/^\/api\/jobs\/[\w-]+\/events$/) && req.method === 'GET') {
        return handleSSE(req);
      }
      if (url.pathname === '/api/jobs' && req.method === 'GET') {
        return handleListJobs(req);
      }
      if (url.pathname === '/health') {
        return new Response('ok');
      }
      return new Response('not found', { status: 404 });
    }
  });
}
```

**Webhook handler flow:**
1. Read body, verify HMAC signature
2. Parse event
3. Find matching job
4. **Save job state FIRST** (crash safety)
5. Execute actions (async)
6. If action fails → update job to failed, save again
7. Push event to SSE clients
8. Return 200

### Step 9: CLI Command

- File: `src/commands/merge.ts`
- The CLI is a client to the server

```
stack merge              # merge bottom unmerged PR
stack merge --all        # cascade: merge entire stack bottom-up
stack merge --status     # show active merge job status
stack merge --dry-run    # show the merge plan without starting
```

**Flow for `stack merge --all`:**
1. Load stack state, build MergeJob from it (store each branch's current tip in `branchTip`)
2. Check server is running (hit `/health`). If not, auto-start it.
3. POST job to `/api/jobs`
4. Connect to `/api/jobs/:id/events` (SSE)
5. Render live updates as they stream in
6. On job complete: run local cleanup (delete local branches, update stack state, checkout trunk)

**Auto-start server:** If `/health` returns nothing:
1. Spawn `bun run src/server/index.ts` as detached process
2. Write PID to `~/.claude/stacks/server.pid`
3. Wait up to 5s for `/health` to respond
4. Proceed with job creation

**UX:**

```
$ stack merge --all

  Merge Plan
  ──────────────────────────────────
  1. #42  add-schema         squash → main
  2. #43  add-resolver       squash → main (after #42)
  3. #44  add-tests          squash → main (after #43)

  ✓ #42 — auto-merge enabled
  ⏳ #42 — waiting for CI + merge...
  ✓ #42 — merged into main
  ✓ #43 — rebased onto main, pushed
  ✓ #43 — auto-merge enabled
  ⏳ #43 — waiting for CI + merge...
  ✓ #43 — merged into main
  ✓ #44 — rebased onto main, pushed
  ✓ #44 — auto-merge enabled
  ⏳ #44 — waiting for CI + merge...
  ✓ #44 — merged into main

  ✓ Stack "my-feature" fully merged (3 PRs)
  ✓ Deleted 3 branches
```

### Step 10: Sync Guard

- File: `src/commands/sync.ts`
- At the top of `execute()`, check for active merge jobs:

```typescript
import { findActiveJobForStack } from '../server/state.js';
// ...
const activeJob = findActiveJobForStack(stackName);
if (activeJob) {
  ui.error(`A merge job is active for this stack. Use "stack merge --status" to check progress.`);
  return 2;
}
```

### Step 11: Register Command + Config

- File: `src/cli.ts` — register MergeCommand, add to help text
- Server config stored in `~/.claude/stacks/server.config.json`:

```json
{
  "webhookSecret": "whsec_...",
  "port": 7654,
  "publicUrl": "https://your-tunnel-url"
}
```

- `stack merge --setup` for first-time webhook configuration:
  - Generate webhook secret
  - Prompt for public URL (user sets up their own tunnel)
  - Create GitHub webhook via `gh api repos/{owner}/{repo}/hooks`
  - Save config

## V1 Scope

Deliberately excluded from v1:
- `stack merge --cancel` (user kills server + `gh pr merge --disable-auto`)
- `stack server` subcommand (auto-start + PID file is enough)
- Multiple merge strategies (squash only, hardcoded)
- `--include-drafts` (drafts are skipped, no flag)
- Review event handling (informational only, not modeled)

## Acceptance Criteria

- [ ] Bun HTTP server receives GitHub webhooks with HMAC verification
- [ ] `stack merge --all` cascades through entire stack, event-driven
- [ ] Bare clone used for rebasing — user's working tree untouched
- [ ] Rebase + force-push between each merge (squash-merge safe)
- [ ] Job state persisted — server restart picks up active jobs
- [ ] `stack merge --status` shows active job progress
- [ ] `stack merge --dry-run` shows merge plan
- [ ] After all PRs merge, branches cleaned up (local + remote)
- [ ] SSE streaming from server to CLI for live updates
- [ ] Sync command refuses to run during active merge job
- [ ] Auto-starts server if not running
- [ ] Handles: CI failure, PR closed, auto-merge disabled
- [ ] All server-side git/gh calls are async (no event loop blocking)

## Risks

1. **`gh pr merge --auto` requires branch protection** — v1 documents this as a hard requirement. Could add a fallback polling mode later.
2. **Action execution failure** — `enable-auto-merge` retries 2x. `rebase-and-push` failure marks job as failed (user must resolve conflicts manually).
3. **Webhook secret in config file** — `~/.claude/stacks/` is outside the repo, but warn if accidentally inside a git tree.
4. **Named tunnel stability** — user's responsibility. If tunnel goes down, webhooks queue in GitHub for ~4 hours, then replayed when tunnel comes back.
