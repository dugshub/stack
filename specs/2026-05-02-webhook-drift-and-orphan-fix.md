# Webhook drift fix + orphan reconciliation + `st daemon repo` CLI

## Goal

Fix two latent webhook bugs in the daemon and surface the previously-API-only repo registration as a CLI:

1. **URL drift**: `ensureWebhook()` PATCHes only `events`, never `config.url` — when the daemon's `publicUrl`/`tunnel.hostname` changes, GitHub keeps delivering to the dead URL.
2. **Orphan accumulation**: `syncWebhooks()` trusts local `config.webhooks` as source of truth — if it's wiped or the user moves laptops, the daemon forgets prior hook IDs and POSTs fresh ones, leaving orphans on GitHub forever.
3. **CLI gap**: `registerRepo`/`unregisterRepo` only reachable via HTTP (`/api/repos`); no `st daemon repo` surface.

## Context

Bugs in `src/server/webhook-manager.ts`:

- Lines 24-44 (`ensureWebhook` existing-hook branch): PATCH payload is `{ events: WEBHOOK_EVENTS }` only. Per [GitHub REST API docs for `PATCH /repos/{owner}/{repo}/hooks/{hook_id}`](https://docs.github.com/en/rest/webhooks/repos#update-a-repository-webhook), the payload may include `config` (replaces the whole config object), `events` (replaces the events array), `add_events`, `remove_events`, `active`. To fix drift we add `config: { url, content_type: 'json', secret }` to the PATCH.
- Lines 85-100 (`syncWebhooks`): iterates `config.repos`, calls `ensureWebhook` per repo. Never calls `GET /repos/{repo}/hooks` to enumerate what GitHub thinks exists.

Wiring (`src/server/index.ts`):
- Line 22: imports from webhook-manager
- Lines 686-703: HTTP routes `POST /api/repos` and `DELETE /api/repos/{repo}` call register/unregister
- Line 767: `syncWebhooks(config)` fired on daemon startup (post-tunnel)

Daemon HTTP client lives at `src/lib/daemon.ts` (`daemonFetch`); used by other CLI commands. Token-authed via `~/.claude/stacks/daemon.token`.

`DaemonConfig` (`src/server/types.ts`): `webhooks: Record<string, number>` maps repo → hook ID. No timestamp or marker.

Conventions (CLAUDE.md): Bun + TS, no build step. Commands extend clipanion `Command`, register in `src/cli.ts`. Patch bump + CHANGELOG entry. Daemon side uses async (`ghAsync` from `spawn.ts`); CLI side uses sync `Bun.spawnSync`. Tests exist via `bun:test` (e.g. `src/commands/absorb.test.ts`) but coverage is sparse.

### Ownership heuristic decision

Goal: identify hooks "owned by this daemon" so we can adopt them after a config wipe **and** so we can detect orphans pointing at dead URLs.

Rejected:
- (a) URL path suffix only — too loose, false positives from unrelated tooling on `/webhooks/github`
- (b) Exact URL match — too strict, misses orphans at old URLs (defeats the purpose)
- (e) Query-string marker `?stack-daemon=1` — most reliable but requires server route change to ignore the query, and existing hooks won't carry the marker so this only helps going forward

**Chosen: (c) signature match** — a hook is "ours" iff:
- `config.url` ends with `/webhooks/github`, AND
- `config.content_type === 'json'`, AND
- the `events` array (sorted) equals `WEBHOOK_EVENTS` (sorted)

Rationale: GitHub's hook list redacts secrets from `config.secret` (returns the literal string `"********"`), so secret comparison is impossible. The triple-match (path suffix + content type + exact event set) is a strong-enough signature that false positives are vanishingly unlikely on a developer's repo. If a user does have an unrelated `/webhooks/github` hook with the exact same event set and JSON content type, adoption is still safe — we'd just patch its URL/secret to ours, which is recoverable (they'd reconfigure their other tool).

Documented in webhook-manager.ts as a comment so future maintainers can see the trade-off.

### Cleanup policy decision

**Chosen: (ii) log + opt-in cleanup**. On reconciliation:
- If multiple matching hooks exist, adopt the first one (preferring one whose URL matches current `webhookUrl`); patch others' URLs to match (so they all point at the live daemon — but we record only one ID). Actually, simpler: adopt the one whose URL matches current `webhookUrl` if any, otherwise the first; **log** the count of extra orphans and **delete** them only when the user runs `st daemon repo doctor --clean` (branch 3).

Rationale: silent deletion is surprising; manual hooks set up by users would be wiped. Logging + opt-in cleanup respects the principle of least surprise. The `doctor --clean` flag makes the destructive path explicit.

Reduced version for branch 2 (no CLI yet): adopt one, log others with their IDs/URLs, never delete in branch 2. Branch 3 adds the cleanup CLI.

### Stack shape

User prefers explicit intermediate states:

- **Branch 1** `dugshub/webhook-fixes/1-patch-url-drift` — minimal: PATCH includes `config.url`. ~10 LoC change. Independent value.
- **Branch 2** `dugshub/webhook-fixes/2-reconcile-orphans` — adds GET-list reconciliation + adoption + orphan logging. Builds on branch 1's PATCH-with-config (so adopted-but-old-URL hooks get fixed up).
- **Branch 3** `dugshub/webhook-fixes/3-st-daemon-repo-cli` — adds `st daemon repo {add,remove,list,doctor}`. `doctor --clean` deletes logged orphans.

## Plan

### Branch 1: PATCH includes `config.url`

**Files:**
- `src/server/webhook-manager.ts` — modify `ensureWebhook` PATCH payload
- `CHANGELOG.md` — add entry under new patch version
- `package.json` — bump 0.9.1 → 0.9.2

**Changes (`webhook-manager.ts` lines 30-37):**

Replace:
```ts
const patchPayload = JSON.stringify({ events: WEBHOOK_EVENTS });
```
with:
```ts
const patchPayload = JSON.stringify({
  config: { url: webhookUrl, content_type: 'json', secret },
  events: WEBHOOK_EVENTS,
});
```

(`webhookUrl` and `secret` are already function params — no signature change needed.)

Also: log when the PATCH actually changes the URL — fetch the existing hook's URL before PATCH, compare, and emit `log('info', ...)` if different. Cheap; helps debug drift in production.

Refactor: extract the temp-file-write-then-PATCH dance into a small helper (`patchHookConfig`) since branch 2 will want the same primitive for adoption. Keep helper in same file.

**Why:** Without `config.url` in PATCH, GitHub keeps delivering to the dead URL.

**Verification:**
- Manual: change `publicUrl` in `~/.claude/stacks/server.config.json`, restart daemon, run `gh api repos/{repo}/hooks/{id}` and confirm URL now matches new value.
- No automated test — would require mocking `ghAsync`.

**Commit message:**
```
fix(daemon): PATCH webhook config.url so URL changes propagate

Existing hooks were updated with the events array but never the URL.
When publicUrl or tunnel.hostname changed between daemon runs, GitHub
kept delivering to the dead URL silently. PATCH now includes the full
config object (url, content_type, secret) alongside events.
```

### Branch 2: orphan reconciliation

**Files:**
- `src/server/webhook-manager.ts` — add `listHooks`, `findOwnedHooks`, modify `ensureWebhook` to call reconciliation when `config.webhooks[repo]` is missing or stale
- `CHANGELOG.md` — entry
- `package.json` — bump to 0.9.3

**Changes (`webhook-manager.ts`):**

1. Add `WEBHOOK_EVENTS_SORTED` constant (sorted copy) for comparison.

2. Add helper:
```ts
type GitHubHook = {
  id: number;
  config: { url?: string; content_type?: string };
  events: string[];
};

async function listHooks(repo: string): Promise<GitHubHook[] | null> {
  const result = await ghAsync('api', `repos/${repo}/hooks`, '--paginate');
  if (!result.ok) {
    log('error', `Failed to list hooks for ${repo}: ${result.stderr}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout) as GitHubHook[];
  } catch (err) {
    log('error', `Could not parse hooks list for ${repo}: ${err}`);
    return null;
  }
}

function isOwnedHook(hook: GitHubHook): boolean {
  const url = hook.config.url ?? '';
  if (!url.endsWith('/webhooks/github')) return false;
  if (hook.config.content_type !== 'json') return false;
  const events = [...hook.events].sort();
  if (events.length !== WEBHOOK_EVENTS_SORTED.length) return false;
  return events.every((e, i) => e === WEBHOOK_EVENTS_SORTED[i]);
}
```

3. Modify `ensureWebhook` flow:

```ts
export async function ensureWebhook(
  repo: string,
  webhookUrl: string,
  secret: string,
  config: DaemonConfig,
): Promise<number | null> {
  // 1. Try cached ID
  let existingId = config.webhooks[repo];
  if (existingId) {
    const check = await ghAsync('api', `repos/${repo}/hooks/${existingId}`, '--jq', '.id');
    if (!check.ok) {
      log('info', `Cached webhook ${existingId} for ${repo} no longer exists; reconciling`);
      delete config.webhooks[repo];
      existingId = undefined;
    }
  }

  // 2. If no cached ID, reconcile against GitHub
  if (!existingId) {
    const hooks = await listHooks(repo);
    if (hooks) {
      const owned = hooks.filter(isOwnedHook);
      if (owned.length > 0) {
        // Prefer one matching the current URL; else first
        const live = owned.find(h => h.config.url === webhookUrl) ?? owned[0];
        existingId = live.id;
        config.webhooks[repo] = existingId;
        saveConfig(config);
        log('success', `Adopted existing webhook ${existingId} for ${repo}`);
        if (owned.length > 1) {
          const orphans = owned.filter(h => h.id !== existingId);
          for (const orphan of orphans) {
            log('warn', `Orphan webhook for ${repo}: id=${orphan.id} url=${orphan.config.url} (run \`st daemon repo doctor --clean\` to remove)`);
          }
        }
      }
    }
  }

  // 3. PATCH if we have an ID (drift fix from branch 1 plus content adoption)
  if (existingId) {
    await patchHookConfig(repo, existingId, webhookUrl, secret);
    return existingId;
  }

  // 4. Create fresh
  // ...existing creation code...
}
```

4. Export the heuristic + listHooks for branch 3's `doctor` to reuse. Also export a `findOrphans(config)` helper that returns `{ repo, hookId, url }[]` for the doctor command.

**Why:** Without reconciliation, lost local config means orphan accumulation forever. Adoption restores idempotency.

**Verification:**
- Manual: delete `~/.claude/stacks/server.config.json` webhooks key, restart daemon, observe log "Adopted existing webhook ..." and confirm `config.webhooks` is repopulated. Confirm `gh api repos/{repo}/hooks` count unchanged (no new hook created).
- Manual: create a second hook on the repo via `gh api repos/{repo}/hooks -X POST ...` with the same events, restart daemon, confirm log shows orphan warning with the second hook's ID.
- Test: add `src/server/webhook-manager.test.ts` covering `isOwnedHook` pure-function logic (no `gh` mock needed). Bun test.

**Commit message:**
```
fix(daemon): reconcile webhooks against GitHub to adopt orphans

Previously the daemon trusted local config.webhooks as source of truth.
A wiped config (or new laptop) caused fresh POSTs and orphan hooks
piled up on GitHub forever. Now syncWebhooks lists existing hooks via
GET /repos/{repo}/hooks and adopts any hook matching our signature
(url path /webhooks/github, content_type json, events match exactly).

Multiple matches are logged as orphans; cleanup is opt-in via the
forthcoming `st daemon repo doctor --clean` command.
```

### Branch 3: `st daemon repo` CLI

**Files:**
- `src/commands/daemon.ts` — extend dispatcher with `repo` action that takes a sub-action (add/remove/list/doctor)
- `src/lib/daemon.ts` — add `daemonFetchJson` helper if missing
- `src/server/index.ts` — add `GET /api/repos` (list) and `POST /api/repos/doctor` (returns orphans, optionally deletes)
- `src/server/webhook-manager.ts` — add `findAllOrphans(config)` and `deleteOrphan(repo, id)` exported helpers
- `CHANGELOG.md` — entry
- `package.json` — bump to 0.9.4

**CLI surface:**
- `st daemon repo add <owner/repo>` — POST `/api/repos`
- `st daemon repo remove <owner/repo>` — DELETE `/api/repos/{repo}`
- `st daemon repo list` — GET `/api/repos` → table of `repo | hook_id | url`
- `st daemon repo doctor` — POST `/api/repos/doctor` → list orphans across all repos
- `st daemon repo doctor --clean` — POST `/api/repos/doctor` with `{ clean: true }` → delete logged orphans, report count

**daemon.ts dispatcher (sketch):**

Extend the switch in `execute()` with `case 'repo': return this.runRepo()`. Then `runRepo()` reads `this.repoAction = Option.String({ required: false })` (need a second positional). Clipanion supports `Option.Rest` or multiple `Option.String` positionals — check the existing pattern. If gnarly, register a separate `DaemonRepoCommand` class with `static override paths = [['daemon', 'repo']]`.

**Decision:** separate command class is cleaner. Register `DaemonRepoCommand`, `DaemonRepoAddCommand`, etc. — but that's verbose. Instead, **single `DaemonRepoCommand`** with one positional `action` and one positional `target` (repo name or empty), dispatched in `execute()`. Mirrors the existing `DaemonCommand` pattern.

```ts
export class DaemonRepoCommand extends Command {
  static override paths = [['daemon', 'repo']];
  action = Option.String({ required: false });
  target = Option.String({ required: false });
  clean = Option.Boolean('--clean', false);
  // ...
}
```

Register in `src/cli.ts` next to `DaemonCommand`.

**Server-side (index.ts):**

```ts
// List repos
if (url.pathname === '/api/repos' && req.method === 'GET') {
  return Response.json({
    repos: cfg.repos.map(r => ({
      repo: r,
      hookId: cfg.webhooks[r] ?? null,
    })),
  });
}

// Doctor — list/clean orphans
if (url.pathname === '/api/repos/doctor' && req.method === 'POST') {
  const body = (await req.json().catch(() => ({}))) as { clean?: boolean };
  const orphans = await findAllOrphans(cfg);
  let deleted = 0;
  if (body.clean) {
    for (const o of orphans) {
      const ok = await deleteOrphan(o.repo, o.hookId);
      if (ok) deleted++;
    }
  }
  return Response.json({ orphans, deleted });
}
```

**Why:** Closes the gap surfaced by bug 2's "run `doctor --clean`" log message. Also makes repo registration discoverable instead of hidden behind HTTP.

**Verification:**
- Manual: `st daemon start`, `st daemon repo add owner/repo`, `st daemon repo list` (shows the repo), `st daemon repo doctor` (shows orphans if any), `st daemon repo doctor --clean` (deletes them).
- No automated test for the CLI path (no test infra for the daemon HTTP loop). `isOwnedHook` test from branch 2 covers the core logic.

**Commit message:**
```
feat(daemon): add `st daemon repo` CLI for repo and orphan management

Exposes the previously API-only repo registration as a first-class CLI:
  st daemon repo add|remove|list — manage watched repos
  st daemon repo doctor [--clean] — list/delete orphan webhooks
```

## Acceptance Criteria

- [ ] Branch 1: PATCH payload includes `config: { url, content_type, secret }`. Manually confirmed against a real repo.
- [ ] Branch 2: `isOwnedHook` is unit-tested. Reconciliation adopts an existing hook when `config.webhooks` is empty. Multiple matches logged as orphans, no auto-delete.
- [ ] Branch 3: All four `st daemon repo` subcommands work end-to-end against a running daemon. `--clean` deletes only hooks identified as ours.
- [ ] Each branch passes `bun run src/cli.ts --help` (no clipanion errors). Branch 2 passes `bun test src/server/webhook-manager.test.ts`.
- [ ] Each branch is its own PR; PR descriptions reference this spec and the bug repro from the parent context.
- [ ] `package.json` and `CHANGELOG.md` updated each branch (0.9.2 → 0.9.3 → 0.9.4).

## Open Questions

- Does `gh api --paginate` work cleanly when called via `ghAsync` (which trims stdout)? If hooks list crosses a page, the merged JSON should still parse; confirm during implementation.
- Should `findAllOrphans` parallelize across repos (Promise.all) or stay sequential (current syncWebhooks pattern)? Sequential is fine for branch 3 — typical user has <10 repos.
- Hook secret is irretrievable from the API. If we adopt a hook, we PATCH the secret to ours — this works because PATCH replaces the config object. Confirmed in branch 1.
