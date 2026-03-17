# Persistent Background Daemon

## Goal

Transform the existing merge-only server into a persistent background daemon that auto-starts on any `stack` command, manages a stable Cloudflare tunnel, keeps a webhook-invalidated cache of PR/CI state, and serves as the backbone for all GitHub-facing operations — making `stack status` instant and `stack merge` a thin client.

## Context

### What exists today

The server (`src/server/`) is merge-scoped:

- **Lifecycle**: Auto-started by `stack merge --all`, dies when merge finishes. PID written but never managed.
- **Tunnel**: Ephemeral `cloudflared tunnel --url` spun up per merge session → random `.trycloudflare.com` URL → webhook must be recreated every time.
- **Webhook**: Created fresh each merge, old ones deleted. Registered from inside `MergeCommand`.
- **Scope**: Only processes merge job events + push-based rebase checks. No caching, no broader event handling.
- **CLI communication**: Merge command POSTs job, streams SSE. Status command reads job state from shared JSON file. All other commands hit GitHub API directly.

### Key files

| File | Lines | Role |
|------|-------|------|
| `src/server/index.ts` | 328 | HTTP server, webhook handler, SSE, job CRUD |
| `src/server/engine.ts` | 133 | Merge job state machine |
| `src/server/state.ts` | 85 | Job persistence (merge-jobs.json) |
| `src/server/types.ts` | 71 | Merge types only |
| `src/server/actions.ts` | 130 | Side effect execution |
| `src/server/webhook.ts` | 108 | Signature verification + event parsing |
| `src/server/clone.ts` | 105 | Bare clone + worktree rebase |
| `src/server/rebase-check.ts` | 152 | Commit status on push events |
| `src/server/spawn.ts` | 36 | Async process spawning |
| `src/commands/merge.ts` | 999 | Merge command (tunnel, webhook, server lifecycle, TUI) |

### Design decisions (from conversation)

- **Auto-start**: daemon starts automatically on any `stack` command if not running
- **Global**: one daemon instance watches all repos with active stacks
- **Tunnel**: Cloudflare named tunnel already created — `stack-daemon` tunnel ID `ae87efd5-487b-4711-a7ae-d44ccafe49aa`, routes `stack.dugsapps.com` → `localhost:7654`, config at `~/.cloudflared/config-stack.yml`
- **Cache**: webhook-invalidated cache of PR/CI state; CLI queries daemon for instant status, falls back to GitHub API if daemon is down
- **Security**: GitHub webhook signatures verified via HMAC-SHA256 (already implemented in `webhook.ts`). The webhook secret is generated once and stored in `server.config.json`. Cloudflare tunnel provides TLS termination. Only signed webhooks from GitHub are processed — unsigned or mismatched requests get 401.
- **v2**: GitHub App for zero-tunnel webhook delivery (not this phase)

### Tunnel already configured

```yaml
# ~/.cloudflared/config-stack.yml
tunnel: ae87efd5-487b-4711-a7ae-d44ccafe49aa
credentials-file: /Users/dug/.cloudflared/ae87efd5-487b-4711-a7ae-d44ccafe49aa.json
ingress:
  - hostname: stack.dugsapps.com
    service: http://localhost:7654
  - service: http_status:404
```

Stable webhook URL: `https://stack.dugsapps.com/webhooks/github`

## Plan

### Step 1: Expand config types and persist tunnel info

- Files: `src/server/types.ts`
- Changes:
  - Rename `ServerConfig` → `DaemonConfig` globally — update all imports in: `index.ts` (lines 8, 36, 284), `merge.ts` (line 21). **Do this first** before any other steps to avoid referencing a stale type name.
  - Add fields: `tunnel.configPath`, `tunnel.hostname`, `webhooks` (map of repo → webhook ID), `repos` (list of repos the daemon watches)
  - Keep backward compat: `port`, `webhookSecret`, `publicUrl` stay

```ts
export interface TunnelConfig {
  configPath: string;     // e.g. ~/.cloudflared/config-stack.yml
  hostname: string;       // e.g. stack.dugsapps.com
}

export interface DaemonConfig {
  port: number;
  webhookSecret: string;
  publicUrl?: string;     // derived from tunnel.hostname or set manually
  tunnel?: TunnelConfig;
  webhooks: Record<string, number>;  // repo full_name → webhook ID
  repos: string[];        // repos we're watching
}
```

  - **Migration** (also referenced in Step 11): `loadDaemonConfig()` in `index.ts` detects old format (no `tunnel` field, no `webhooks` field) and populates defaults: `webhooks: {}`, `repos: []`. This migration runs on load, not as a separate step — so Steps 2–10 can all reference `DaemonConfig` safely.

### Step 2: Daemon lifecycle module

- Files: `src/server/lifecycle.ts` (new)
- Changes:
  - `isDaemonRunning(): boolean` — **synchronous**. Read PID file (`~/.claude/stacks/daemon.pid`), check if process exists via `process.kill(pid, 0)` (no signal, just existence check). If PID file exists but process is dead → **delete stale PID file** and return `false`.
  - `isDaemonHealthy(): Promise<boolean>` — **async**. Calls `fetch('http://localhost:${port}/health')`. Used when we need to confirm the daemon is actually serving (not just alive).
  - `startDaemon(): Promise<{ pid: number; port: number }>` — spawn `bun run src/server/index.ts` detached, write PID to `daemon.pid`, redirect stdout/stderr to `~/.claude/stacks/daemon.log` (append mode). Wait up to 5s for health check. **If port is already bound** (health check returns non-daemon response or connection refused persists), throw with clear error: `"Port 7654 in use by another process"`.
  - `stopDaemon(): boolean` — **synchronous**. Read PID, send SIGTERM, delete PID file. Returns true if stopped.
  - `ensureDaemon(): Promise<{ port: number }>` — **async**. Called by CLI. Sequence: (1) `isDaemonRunning()` sync check, (2) if stale PID found, clean up, (3) if not running, call `startDaemon()`, (4) return port. This function is `async` and must be `await`ed in `cli.ts`.
  - `getDaemonPort(): number` — **synchronous**. Reads port from config file, defaults to 7654. Used by status/dashboard for cache queries.
  - `daemonStatus(): Promise<DaemonStatusInfo>` — calls `GET /api/status` on daemon, returns structured info
  - PID file: `~/.claude/stacks/daemon.pid` (replaces old `server.pid` — Step 10 removes the old `server.pid` write in `merge.ts`)
  - Log file: `~/.claude/stacks/daemon.log` — append mode. On daemon startup, if file > 1MB, rename to `daemon.log.1` (keep one backup), then create fresh. This preserves the previous session for debugging.

### Step 3: Tunnel management in daemon startup

- Files: `src/server/tunnel.ts` (new), `src/server/index.ts`
- Changes:
  - `startTunnel(config: DaemonConfig)` — spawn `cloudflared tunnel run --config <configPath>`, return child process. Only starts if `config.tunnel` is set.
  - `stopTunnel(proc)` — SIGTERM the cloudflared process
  - In `index.ts`: on `import.meta.main`, after starting HTTP server, start tunnel. On SIGTERM/SIGINT, stop tunnel + server gracefully.
  - Tunnel process supervised: if cloudflared dies, restart after 5s backoff, **max 10 restarts** then log error and stop retrying (avoid spin loop from misconfigured tunnel)

### Step 4: Webhook registration in daemon (move from merge.ts)

- Files: `src/server/webhook-manager.ts` (new), `src/server/index.ts`
- Changes:
  - `ensureWebhook(repo, webhookUrl, secret)` → creates webhook if not in config, updates config with webhook ID. **Webhook events list**: `['pull_request', 'push', 'check_suite', 'check_run']` — includes CI events needed by Step 5's cache.
  - `syncWebhooks(config)` → called on daemon startup, ensures all `config.repos` have webhooks pointing to `config.publicUrl`. Also verifies existing webhooks have the correct events list — if a webhook was created with the old `['pull_request', 'push']` set, update it via `PATCH /repos/:repo/hooks/:id` to add `check_suite` and `check_run`.
  - `registerRepo(repo)` → add repo to watch list, create webhook — called via new API endpoint `POST /api/repos`
  - On daemon startup: call `syncWebhooks()` to verify existing webhooks still exist (ping test via GitHub API)

### Step 5: PR/CI cache

- Files: `src/server/cache.ts` (new), `src/server/types.ts`
- Changes:
  - In-memory cache: `Map<string, RepoCacheEntry>` keyed by `owner/repo`
  - Each entry holds `Map<number, CachedPR>` where `CachedPR` has: PR number, state (OPEN/CLOSED/MERGED), isDraft, reviewDecision, checksStatus, title, updatedAt
  - Cache populated two ways:
    1. **Webhook events** — pr_merged, pr_closed, push events update relevant entries immediately
    2. **On-demand refresh** — when CLI queries `/api/stacks/:repo/:name`, if cache is older than 30s for that stack's PRs, do a background `gh api graphql` batch fetch (same query as `gh.prViewBatch`) and update cache
  - New webhook events to parse (expand `parseWebhook` in `webhook.ts`):
    - `pull_request.synchronize` → update checksStatus to 'PENDING'
    - `pull_request.review_requested` → update cache
    - `pull_request.ready_for_review` → isDraft = false
    - `pull_request.converted_to_draft` → isDraft = true
    - `check_suite` / `check_run` events → update checksStatus (subscribe to these events on webhook)
  - Cache is ephemeral (in-memory only) — rebuilds on daemon restart from first CLI query. **Known limitation**: the first `stack status` after a daemon restart incurs a full GitHub API round trip. This is intentional — the cache warms quickly from subsequent webhook events and CLI queries.
  - Expose: `GET /api/cache/:owner/:repo/prs` → returns cached PR states for a repo (note: owner and repo are separate path segments to avoid ambiguity with slash in full repo name)

### Step 6: Expand HTTP API for CLI consumption

- Files: `src/server/index.ts`
- Changes: Add new routes:

```
GET  /health                          — no auth (used by lifecycle health check)
POST /webhooks/github                 — HMAC signature (x-hub-signature-256)
GET  /api/status                      — bearer token — daemon status (uptime, tunnel health, repos, job count)
POST /api/repos                       — bearer token — register a repo (creates webhook)
DELETE /api/repos/:repo               — bearer token — unregister a repo (removes webhook)
GET  /api/cache/:owner/:repo/prs      — bearer token — cached PR statuses for a repo
GET  /api/cache/:owner/:repo/pr/:num  — bearer token — single PR cache entry
GET  /api/jobs                        — bearer token — already exists
POST /api/jobs                        — bearer token — already exists
GET  /api/jobs/:id                    — bearer token — already exists
GET  /api/jobs/:id/events             — bearer token — already exists (SSE)
```

  - Auth middleware: check `Authorization: Bearer <token>` header against `daemon.token` file contents for all `/api/*` routes. Return 401 on mismatch. Skip auth for `/health` and `/webhooks/github`.
  - `GET /api/status` response includes `tunnel` field: `{ running: boolean, hostname: string, restarts: number }` so CLI can report tunnel health.

### Step 7: `stack daemon` command

- Files: `src/commands/daemon.ts` (new), `src/cli.ts`
- Changes:
  - Subcommands: `stack daemon start`, `stack daemon stop`, `stack daemon status`, `stack daemon logs`, `stack daemon setup`
  - `start` — start daemon (if not running), show PID + tunnel URL
  - `stop` — graceful shutdown
  - `status` — show running state, tunnel status, watched repos, active merge jobs. **Calls `GET /api/status`** from Step 6 to get live daemon info.
  - `logs` — tail `~/.claude/stacks/daemon.log` (last 50 lines, or `-f` for follow)
  - `setup` — interactive: detect tunnel config, generate webhook secret, write `DaemonConfig`
  - Register in `cli.ts`
  - Add `'daemon'` to `noRepoRequired` list in `cli.ts` (daemon commands don't need a git repo)

### Step 8: Auto-start daemon from CLI

- Files: `src/cli.ts`
- Changes:
  - `ensureDaemon()` is **async** — insert `await ensureDaemon()` in the async flow of `cli.ts`, between the git repo check (line 59) and `cli.run(args)` (line 130). The existing structure already supports this since `cli.run()` is awaited.
  - If daemon starts, print one-liner to stderr: `daemon started (pid 12345)`
  - Don't auto-start for: `daemon stop`, `daemon status`, `daemon logs`, `--help`, `--version`, `update`, `--ai`
  - Auto-register current repo: after daemon is confirmed running, **fire-and-forget** a `POST /api/repos` with the repo name. To avoid per-invocation latency from `gh.repoFullName()` (which shells out to `gh api`), **cache the repo name in the stack state file** — `state.repo` is already populated by most commands. Read it from `loadState().repo` (synchronous file read). Only call `gh.repoFullName()` if `state.repo` is empty (first use). The `POST /api/repos` itself is fire-and-forget (no `await`) — daemon idempotently ignores already-registered repos. **Include bearer token** from `~/.claude/stacks/daemon.token` in the `Authorization` header (read token via `loadDaemonToken()` from `daemon-client.ts`).

### Step 9: CLI queries daemon for status

- Files: `src/commands/status.ts`, `src/lib/gh.ts`, `src/lib/dashboard.ts`
- Changes:
  - Create `src/lib/daemon-client.ts` (new) with:
    - `loadDaemonToken(): string | null` — reads `~/.claude/stacks/daemon.token`, returns token string or `null` if file missing. Cached in-process after first read.
    - `daemonFetch(path: string): Promise<Response | null>` — wrapper around `fetch('http://localhost:${port}${path}')` that adds `Authorization: Bearer <token>` header, 200ms timeout, returns `null` on any failure. Used by all daemon client calls.
    - `tryDaemonCache(owner: string, repo: string): Promise<Map<number, PrStatus> | null>` — calls `daemonFetch('/api/cache/${owner}/${repo}/prs')`, returns parsed `Map<number, PrStatus>` or `null` on failure.
  - In `StatusCommand.showActiveStack()`: **make `execute()` async** (it already returns `Promise<number>`). Before calling `gh.prViewBatch()`, call `await tryDaemonCache(owner, repo)`. If non-null, use it. Otherwise fall back to `gh.prViewBatch()`.
  - In `dashboard.ts`: **make `showDashboard()` async** (returns `Promise<number | null>` instead of `number | null`). Update caller in `cli.ts` to `await showDashboard()`. This is required because `fetch()` to the daemon cache is inherently async. The dashboard currently calls synchronous `gh.prViewBatch()` — replace with `await tryDaemonCache()` first, fall back to `gh.prViewBatch()`.
  - Timeout on daemon cache fetch: 200ms. If daemon is slow or stuck, we'd rather fall back to GitHub than block the CLI.

### Step 10: Simplify merge.ts

- Files: `src/commands/merge.ts`
- Changes:
  - Remove these methods entirely: `ensureTunnel()` (lines 776–838), `ensureWebhook()` (lines 840–889), `autoStartServer()` (lines 916–942), `runSetup()` (lines 944–998), `checkHealth()` (lines 907–914), `getServerPort()` (lines 891–905), `ensureConfig()` (lines 753–772)
  - Remove the `tunnelProc` field (line 774) **and all its usages**: `this.tunnelProc.kill()` at line 536 (inside `streamEvents`), line 684 (inside `streamEventsSimple`), and line 719 (inside `cleanupLocal`). These are the three call sites that reference the field beyond its declaration.
  - Remove PID file write at old path `server.pid` (was in `autoStartServer` — already gone with method removal)
  - Remove `--setup` flag (line 50–52) **and its usage example** in `static override usage` (lines 34–35, the `['Set up webhook configuration', 'stack merge --setup']` entry). Update the examples array.
  - Remove the `if (this.setup)` branch (lines 59–61)
  - Replace with: `ensureDaemon()` call (Step 8 already does this globally via `cli.ts`)
  - `startMerge()` becomes: validate stack → build job → `POST /api/jobs` to `http://localhost:${getDaemonPort()}` → stream SSE. Uses `getDaemonPort()` from `lifecycle.ts`.
  - Keep: dry-run, status display, TUI streaming (`streamEvents`/`streamEventsSimple`), cleanupLocal — these are CLI-side concerns

### Step 11: Config migration and cleanup

- Files: `src/server/index.ts`
- Changes:
  - The `loadDaemonConfig()` function (updated in Step 1) handles migration transparently: if old format detected (no `tunnel` field, no `webhooks` field), preserve existing `port` and `webhookSecret`, add defaults (`webhooks: {}`, `repos: []`). Write back immediately so config file is always in new format.
  - Config file path stays the same: `~/.claude/stacks/server.config.json` (no rename — avoids breaking existing setups)
  - Delete old `server.pid` if found alongside new `daemon.pid` (one-time cleanup)
  - **Token generation happens in daemon startup** (inside `index.ts` when `import.meta.main` runs): if `~/.claude/stacks/daemon.token` doesn't exist, generate a random token (`crypto.randomUUID()`) and write it. This ensures the token exists before any API requests arrive. The token file survives daemon restarts (persistent on disk). `stack daemon setup` can regenerate it if needed.

## Security Model

### Webhook verification

Webhooks are secured through GitHub's HMAC-SHA256 signature verification (already implemented in `webhook.ts:verifySignature()`). The flow:

1. `webhookSecret` generated once during `stack daemon setup`, stored in `~/.claude/stacks/server.config.json`
2. Same secret passed to GitHub when creating the webhook
3. Every incoming webhook request verified: `x-hub-signature-256` header checked against HMAC of request body with the shared secret
4. Failed verification → 401 response, event dropped

### Tunnel exposure

The Cloudflare tunnel provides TLS and routes `stack.dugsapps.com` → `localhost:7654`. **Important**: the current ingress config proxies *all paths* to localhost — not just `/webhooks/github`. This means `/api/cache/*`, `/api/jobs/*`, etc. are also reachable externally at `https://stack.dugsapps.com/api/...`.

**Mitigation for Phase 1**: Add path-based auth in the daemon HTTP handler. Non-webhook routes (`/api/*`, `/health`) require a local auth token:
- On daemon startup, generate a random token and write it to `~/.claude/stacks/daemon.token`
- CLI reads this token file and sends it as `Authorization: Bearer <token>` header
- Daemon rejects external `/api/*` requests that lack the correct token (401)
- `/webhooks/github` is exempt — it uses GitHub's HMAC signature instead
- This prevents anyone who discovers the hostname from reading cached PR data

This is lightweight and sufficient for a personal tool. v2 GitHub App eliminates the tunnel entirely.

## Acceptance Criteria

- [ ] `stack daemon start` starts the daemon, tunnel, and prints status
- [ ] `stack daemon stop` gracefully shuts down daemon + tunnel
- [ ] `stack daemon status` shows PID, uptime, tunnel URL, watched repos (calls `GET /api/status`)
- [ ] `stack daemon logs` shows recent daemon logs
- [ ] Running any `stack` command auto-starts daemon if not running (one-liner output)
- [ ] Daemon auto-registers current repo's webhook on first CLI use (fire-and-forget, no latency)
- [ ] Webhook URL is stable (`https://stack.dugsapps.com/webhooks/github`) — never changes
- [ ] Webhook subscribes to `pull_request`, `push`, `check_suite`, `check_run` events
- [ ] `stack status` uses cached PR state from daemon (instant response when daemon is up)
- [ ] `stack status` falls back to GitHub API when daemon is down (200ms timeout on cache fetch)
- [ ] `showDashboard()` is async and uses daemon cache
- [ ] `stack merge --all` works with simplified flow (no tunnel/webhook management in merge command)
- [ ] `stack merge --setup` removed (and usage example updated), replaced by `stack daemon setup`
- [ ] All `tunnelProc` references removed from merge.ts (field + 3 call sites)
- [ ] Daemon survives CLI process exit (detached, PID-managed)
- [ ] Stale PID files detected and cleaned up automatically
- [ ] Port conflict produces clear error message
- [ ] Daemon restarts tunnel if cloudflared crashes (max 10 restarts)
- [ ] Webhook signature verification prevents unauthorized events
- [ ] API endpoints behind bearer token auth (daemon.token file)
- [ ] Daemon log rotation (rename to .log.1 at 1MB, keep one backup)
- [ ] First `stack status` after daemon restart falls back to GitHub API (cache cold start is intentional)

## Resolved Questions

- **Log rotation**: Rename to `daemon.log.1` at 1MB, keep one backup file. Preserves previous session for debugging.
- **Stale PID**: `ensureDaemon()` detects dead PIDs via `process.kill(pid, 0)`, cleans up stale PID file, auto-restarts.
- **Port conflict**: `startDaemon()` throws with `"Port 7654 in use by another process"` if health check fails after spawn.
- **Async lifecycle**: `ensureDaemon()` is async, awaited in `cli.ts` before `cli.run()`.
- **Repo registration latency**: Use `loadState().repo` (sync file read) instead of `gh.repoFullName()`. Fire-and-forget POST.
- **Dashboard sync→async**: `showDashboard()` becomes async, caller in `cli.ts` updated.
- **Tunnel security**: All `/api/*` routes behind bearer token auth. Only `/webhooks/github` uses HMAC.

## Open Questions

- **Cache TTL**: 30s staleness threshold for on-demand refresh — tune based on usage patterns.
- **Multi-machine**: If user works from multiple machines, each needs its own daemon + tunnel. The stable URL only works for one. v2 GitHub App solves this.
