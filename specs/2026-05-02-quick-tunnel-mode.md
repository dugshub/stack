# Quick-tunnel mode for daemon (zero-config public URL)

## Goal

Let users run the daemon's webhook receiver behind a free `trycloudflare.com` quick tunnel — no Cloudflare account, no DNS, no `config-stack.yml`. The URL rotates on every daemon start; webhook URLs on GitHub must be re-PATCHed each run so deliveries keep working.

## Context

Today the daemon only supports a **named** Cloudflare tunnel (`src/server/tunnel.ts:9` — runs `cloudflared tunnel --config <path> run`). The daemon command auto-detects `~/.cloudflared/config-stack.yml` and writes a fixed `tunnel: { configPath, hostname }` into `~/.claude/stacks/server.config.json` (`src/commands/daemon.ts:289-298`). For a user without a Cloudflare-managed zone this is a wall.

Quick tunnels are spun up with `cloudflared tunnel --url http://localhost:7654`. cloudflared writes the assigned URL to **stderr** in a banner like:

```
2026-05-02T20:55:18Z INF Your quick Tunnel has been created! Visit it at:
2026-05-02T20:55:18Z INF +--------------------------------------------------------+
2026-05-02T20:55:18Z INF |  https://foo-bar-baz-qux.trycloudflare.com             |
2026-05-02T20:55:18Z INF +--------------------------------------------------------+
```

The webhook reconciler (`src/server/webhook-manager.ts`) already PATCHes hook URLs on every `ensureWebhook` call (post-2026-05-02-webhook-drift fix), so once we know the new URL we can call `syncWebhooks(cfg)` and every hook on GitHub gets updated. The startup race in `src/server/index.ts:786-793` currently calls `syncWebhooks` immediately after `startTunnel` — for quick mode we must defer that call until cloudflared has reported its URL.

`DaemonConfig.publicUrl` (`src/server/types.ts:24`) is the field webhook-manager checks first; setting it makes `syncWebhooks` use that URL. `tunnel.hostname` is the fallback.

Conventions (CLAUDE.md): Bun + TS, no build step, `Bun.spawn` for async procs (already used by tunnel.ts), patch-bump + CHANGELOG entry, register commands via clipanion, sync `Bun.spawnSync` on CLI side.

## Approach

1. Extend `TunnelConfig` to a discriminated union: `{ mode: 'named', configPath, hostname }` | `{ mode: 'quick' }`. Existing configs (no `mode`) treated as `'named'`. The `'quick'` shape carries no static URL — the live URL is held in module state inside `tunnel.ts` and mirrored to `cfg.publicUrl` once known.
2. `tunnel.ts` learns to spawn `cloudflared tunnel --url http://localhost:<port>` when `mode === 'quick'`, parses stderr for the trycloudflare URL via regex, and invokes a `onUrlReady(url)` callback the caller passes in. Auto-restart logic stays as-is; on each restart a new URL appears and the callback fires again.
3. `index.ts` startup logic: for `mode === 'quick'`, pass a callback that updates `cfg.publicUrl`, persists config, and calls `syncWebhooks(cfg)`. Suppress the eager `syncWebhooks(config)` call on startup when `mode === 'quick'` (it would either no-op or push the *previous* URL).
4. `daemon.ts setup` gains a `--quick` flag. When set, writes `tunnel: { mode: 'quick' }`, clears any stale `publicUrl`. Default behavior unchanged (auto-detect named config). Add a friendly error if `--quick` is set but `cloudflared` is not on PATH.
5. `daemon status` shows `Tunnel: connected (quick: <url>)` for quick mode, including restart count.
6. No webhook-side changes needed — the existing PATCH path already handles URL drift.

### Tradeoffs / non-goals

- **Stale GitHub hooks while daemon is down**: when the daemon stops, GitHub keeps delivering to the dead trycloudflare URL until next start. Acceptable — webhook deliveries silently fail, no orphan accumulation. **Not** doing tear-down-on-shutdown: it would race with crash-restart and leave repos hookless if cloudflared bounces.
- **First-event-after-start race**: between cloudflared reporting URL → `syncWebhooks` finishing → first webhook arriving, GitHub may still target the *previous* URL. We accept the loss; webhook delivery is best-effort and the user manually retriggers if needed.
- **stderr parsing brittleness**: cloudflared's banner format is stable across recent versions but not contractual. Regex is `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`; if cloudflared ever changes the format the daemon logs a warning ("tunnel started but URL not detected within 30s") and the user falls back to named mode. No retries — restart loop handles that.

## Steps

### 1. Update types — `src/server/types.ts`

Replace `TunnelConfig` with a discriminated union:

```ts
export type TunnelConfig =
  | { mode: 'named'; configPath: string; hostname: string }
  | { mode: 'quick' };
```

Back-compat in loader: in `loadDaemonConfig` (`src/server/index.ts:524`), normalize legacy `tunnel: { configPath, hostname }` (no `mode`) by injecting `mode: 'named'`.

**All callsites that read `tunnel.hostname` / `tunnel.configPath`** — must be updated atomically with the type change (TypeScript will catch some, but `daemon.ts` uses `as { hostname: string }` casts that compile silently and produce runtime `undefined`):

- `src/server/webhook-manager.ts:191` (`syncWebhooks`) — guard fallback with `cfg.tunnel.mode === 'named'`; for `mode === 'quick'` without `publicUrl`, return early with the existing "no public URL" log line. Do **not** fall through.
- `src/server/webhook-manager.ts:217` (`registerRepo`) — same guard.
- `src/server/index.ts:594` (`/api/status` handler) — replaced wholesale by step 5 below.
- `src/commands/daemon.ts:117` (`runStart` post-start banner) — branch on `config.tunnel.mode`; for quick mode print `Tunnel: quick (URL pending)` since the URL isn't known yet at start.
- `src/commands/daemon.ts:164-170` (`runStatus` rendering) — see step 5.
- `src/commands/daemon.ts:312-315` (`runSetup` summary) — branch on mode.

Drop the `as { hostname: string }` casts in `daemon.ts`; replace with proper narrowing on `mode`.

### 2. Extend `tunnel.ts`

```ts
export type TunnelStartedCallback = (publicUrl: string) => void;

export function startTunnel(
  config: DaemonConfig,
  onUrlReady?: TunnelStartedCallback,
): ReturnType<typeof Bun.spawn> | null { ... }
```

- For `mode === 'named'`: existing args (`['cloudflared', 'tunnel', '--config', t.configPath, 'run']`). On spawn success, immediately invoke `onUrlReady(`https://${t.hostname}`)` so the caller can run `syncWebhooks` consistently for both modes.
- For `mode === 'quick'`: args `['cloudflared', 'tunnel', '--url', `http://localhost:${config.port}`, '--no-autoupdate']`. Capture stderr (currently `'pipe'` already), read line by line, regex-match `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`. On first match, log success and invoke `onUrlReady(url)`. Subsequent matches in the same proc are ignored.
- Auto-restart loop unchanged. On restart the new URL is parsed and `onUrlReady` fires again.
- No new exports beyond `startTunnel` signature change. The "current URL" is held in `cfg.publicUrl` (set by the callback in `index.ts`) and read directly there — no module-scoped state in `tunnel.ts` beyond what already exists.
- No ENOENT / `Bun.which` check inside `startTunnel`. The setup-time check in step 4 is the user-facing guard; a runtime miss just lets the existing `MAX_RESTARTS=10` loop give up and log.

### 3. Wire callback in `index.ts`

In the `import.meta.main` block (~line 786):

```ts
if (config.tunnel) {
  const onUrlReady = (publicUrl: string): void => {
    config.publicUrl = publicUrl;
    saveDaemonConfig(config);
    syncWebhooks(config).catch((err) => log('error', `Webhook sync failed: ${err}`));
  };
  startTunnel(config, onUrlReady);
} else {
  // No tunnel — sync once with whatever publicUrl is in config (probably none)
  syncWebhooks(config).catch((err) => log('error', `Webhook sync failed: ${err}`));
}
```

Remove the unconditional `syncWebhooks(config)` at line 791-793. Add a small `saveDaemonConfig(cfg)` helper (or reuse the existing one in `webhook-manager.ts` — it's already private there; export it).

### 4. CLI flag — `src/commands/daemon.ts`

In `DaemonCommand`, add:

```ts
quickTunnel = Option.Boolean('--quick', false, {
  description: 'Use a free trycloudflare.com quick tunnel (no Cloudflare account needed)',
});
```

In `runSetup()`:
- If `this.quickTunnel`: check `cloudflared` is on PATH (use `Bun.which('cloudflared')`); error out with install instructions if missing. Set `config.tunnel = { mode: 'quick' }`. Clear `config.publicUrl` (will be set by daemon on next start).
- Else: keep existing auto-detect. If detected, normalize to `{ mode: 'named', configPath, hostname }`.
- Status print: branch on `config.tunnel.mode`.

### 5. Status display — atomic update across server, type, and CLI

These three changes ship in one commit so the wire format stays consistent:

**a)** `src/server/index.ts` `/api/status` handler (~line 591):

```ts
tunnel: cfg.tunnel
  ? {
      mode: cfg.tunnel.mode,
      running: isTunnelRunning(),
      url: cfg.publicUrl ?? null,  // null until quick URL parsed; for named, set immediately by callback
      restarts: getTunnelRestartCount(),
    }
  : null,
```

**b)** `src/server/lifecycle.ts:187` `DaemonStatusInfo`:

```ts
tunnel: { mode: 'named' | 'quick'; running: boolean; url: string | null; restarts: number } | null;
```

**c)** `src/commands/daemon.ts:164-170` `runStatus` rendering:

```ts
if (info.tunnel) {
  const status = info.tunnel.running ? 'connected' : 'down';
  const urlPart = info.tunnel.url ?? '(URL pending)';
  process.stderr.write(`  Tunnel:  ${status} ${info.tunnel.mode} ${urlPart}\n`);
  if (info.tunnel.restarts > 0) {
    process.stderr.write(`  Restarts: ${info.tunnel.restarts}\n`);
  }
}
```

### 6. Bump + changelog

- `package.json`: 0.9.4 → 0.9.5.
- `CHANGELOG.md`: entry under 0.9.5 — "Quick-tunnel mode (`st daemon setup --quick`) — zero-config public URL via trycloudflare.com; webhook URL re-synced on each daemon start."

## Verification

- `st daemon setup --quick` writes `tunnel: { mode: 'quick' }` to `server.config.json`.
- `st daemon stop && st daemon start` — within ~5s, log shows `Tunnel started: https://<random>.trycloudflare.com` followed by webhook PATCH lines for each registered repo.
- `st daemon status` renders `Tunnel: connected (quick: https://...)`.
- `gh api repos/<repo>/hooks/<id> --jq .config.url` returns the new trycloudflare URL.
- External: `curl -X POST https://<random>.trycloudflare.com/webhooks/github -H "X-GitHub-Event: ping"` returns HTTP 401 (signature check rejects, endpoint reachable).
- Restart daemon a second time → new URL in logs, webhook PATCHed again.
- Existing `webhook-manager.test.ts` and any tunnel tests still pass: `bun test`.
- Type check via `bunx tsc --noEmit` (no project script exists; `package.json` has no `scripts` block).

## Out of scope

- GUI / interactive setup wizard.
- Quick-tunnel cleanup of GitHub hooks on graceful shutdown (would race with crash-restart).
- Falling back to quick mode if named mode fails — keep modes explicit.
- Multi-tunnel / load balancing.
