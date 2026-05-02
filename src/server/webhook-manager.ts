import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './log.js';
import { ghAsync } from './spawn.js';
import type { DaemonConfig } from './types.js';

const CONFIG_PATH = join(homedir(), '.claude', 'stacks', 'server.config.json');

const WEBHOOK_EVENTS = ['pull_request', 'push', 'check_suite', 'check_run'];
const WEBHOOK_EVENTS_SORTED = [...WEBHOOK_EVENTS].sort();

/** Path component the daemon's webhook server listens on. */
const WEBHOOK_PATH_SUFFIX = '/webhooks/github';

/**
 * Subset of GitHub's repo-hook payload the reconciler cares about.
 * GitHub redacts `config.secret` to "********" on read, so secret comparison
 * is impossible; ownership is inferred from url path + content type + events.
 */
export type GitHubHook = {
	id: number;
	config: { url?: string; content_type?: string };
	events: string[];
};

/**
 * Heuristic: a hook is "owned by this daemon" iff
 *   - its config.url path ends with /webhooks/github, AND
 *   - content_type is json, AND
 *   - its events array (sorted) exactly equals WEBHOOK_EVENTS (sorted).
 *
 * The events-set match makes false positives on a developer's repo
 * vanishingly unlikely. Adopting a hook is recoverable: we PATCH it to point
 * at the live URL with our secret. See spec for trade-offs (alt heuristics).
 */
export function isOwnedHook(hook: GitHubHook): boolean {
	const url = hook.config.url ?? '';
	if (!url.endsWith(WEBHOOK_PATH_SUFFIX)) return false;
	if (hook.config.content_type !== 'json') return false;
	const events = [...(hook.events ?? [])].sort();
	if (events.length !== WEBHOOK_EVENTS_SORTED.length) return false;
	return events.every((e, i) => e === WEBHOOK_EVENTS_SORTED[i]);
}

/** GET /repos/{repo}/hooks. Returns null on API failure. */
async function listHooks(repo: string): Promise<GitHubHook[] | null> {
	const result = await ghAsync('api', `repos/${repo}/hooks`, '--paginate');
	if (!result.ok) {
		log('error', `Failed to list hooks for ${repo}: ${result.stderr}`);
		return null;
	}
	try {
		const parsed = JSON.parse(result.stdout) as GitHubHook[];
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		log('error', `Could not parse hooks list for ${repo}: ${err}`);
		return null;
	}
}

function saveConfig(config: DaemonConfig): void {
	mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/**
 * PATCH the GitHub-side hook so its config (url, content_type, secret) and
 * events match the daemon's current state. Sending `config` replaces the
 * whole config object on GitHub's side — that's the documented behavior of
 * PATCH /repos/{owner}/{repo}/hooks/{hook_id}, and it's the only way to
 * propagate URL changes when publicUrl/tunnel.hostname drifts between runs.
 */
async function patchHookConfig(
	repo: string,
	hookId: number,
	webhookUrl: string,
	secret: string,
): Promise<boolean> {
	const patchPayload = JSON.stringify({
		config: { url: webhookUrl, content_type: 'json', secret },
		events: WEBHOOK_EVENTS,
	});
	const tmpPatchFile = join(homedir(), '.claude', 'stacks', `webhook-patch-${Date.now()}.json`);
	writeFileSync(tmpPatchFile, patchPayload, 'utf-8');
	const result = await ghAsync(
		'api', `repos/${repo}/hooks/${hookId}`,
		'--method', 'PATCH',
		'--input', tmpPatchFile,
	);
	try { unlinkSync(tmpPatchFile); } catch { /* ignore */ }
	if (!result.ok) {
		log('error', `Webhook PATCH failed for ${repo} (id ${hookId}): ${result.stderr}`);
	}
	return result.ok;
}

export async function ensureWebhook(
	repo: string,
	webhookUrl: string,
	secret: string,
	config: DaemonConfig,
): Promise<number | null> {
	// Check if we already have a webhook ID for this repo
	const existingId = config.webhooks[repo];
	if (existingId) {
		// Verify webhook still exists; fetch its current url so we can log drift
		const check = await ghAsync('api', `repos/${repo}/hooks/${existingId}`, '--jq', '.config.url');
		if (check.ok) {
			const currentUrl = check.stdout.trim();
			if (currentUrl && currentUrl !== webhookUrl) {
				log('info', `Webhook url drift for ${repo}: ${currentUrl} -> ${webhookUrl}`);
			}
			// PATCH to ensure config (url/content_type/secret) and events are current.
			// Even if patch fails, webhook exists — return its ID.
			await patchHookConfig(repo, existingId, webhookUrl, secret);
			return existingId;
		}
		// Webhook was deleted externally — fall through to reconcile/create
		delete config.webhooks[repo];
	}

	// Reconcile against GitHub: maybe a hook we own already exists but our
	// local config forgot the ID (config wipe, new laptop, etc.).
	const hooks = await listHooks(repo);
	if (hooks) {
		const owned = hooks.filter(isOwnedHook);
		if (owned.length > 0) {
			// Prefer one whose URL already matches the current webhookUrl;
			// otherwise just take the first.
			// biome-ignore lint/style/noNonNullAssertion: owned.length > 0
			const adopt = owned.find(h => h.config.url === webhookUrl) ?? owned[0]!;
			config.webhooks[repo] = adopt.id;
			saveConfig(config);
			log('success', `Adopted existing webhook ${adopt.id} for ${repo}`);
			if (owned.length > 1) {
				const orphans = owned.filter(h => h.id !== adopt.id);
				for (const orphan of orphans) {
					log('warn', `Orphan webhook for ${repo}: id=${orphan.id} url=${orphan.config.url ?? '?'} (run \`st daemon repo doctor --clean\` to remove)`);
				}
			}
			// PATCH the adopted hook so its URL/secret/events are current.
			await patchHookConfig(repo, adopt.id, webhookUrl, secret);
			return adopt.id;
		}
	}

	// Create new webhook
	const payload = JSON.stringify({
		config: { url: webhookUrl, content_type: 'json', secret },
		events: WEBHOOK_EVENTS,
		active: true,
	});

	const tmpFile = join(homedir(), '.claude', 'stacks', `webhook-tmp-${Date.now()}.json`);
	writeFileSync(tmpFile, payload, 'utf-8');

	const result = await ghAsync(
		'api', `repos/${repo}/hooks`,
		'--method', 'POST',
		'--input', tmpFile,
		'--jq', '.id',
	);

	try {
		const { unlinkSync } = await import('node:fs');
		unlinkSync(tmpFile);
	} catch { /* ignore */ }

	if (!result.ok) {
		log('error', `Webhook creation failed for ${repo}: ${result.stderr}`);
		return null;
	}

	const hookId = Number.parseInt(result.stdout.trim(), 10);
	if (Number.isNaN(hookId)) {
		log('error', `Could not parse webhook ID from: ${result.stdout}`);
		return null;
	}

	config.webhooks[repo] = hookId;
	saveConfig(config);
	log('success', `Webhook created for ${repo} (id: ${hookId})`);
	return hookId;
}

export async function syncWebhooks(config: DaemonConfig): Promise<void> {
	const webhookUrl = config.publicUrl
		? `${config.publicUrl}/webhooks/github`
		: config.tunnel
			? `https://${config.tunnel.hostname}/webhooks/github`
			: null;

	if (!webhookUrl) {
		log('info', 'No public URL or tunnel configured — skipping webhook sync');
		return;
	}

	for (const repo of config.repos) {
		await ensureWebhook(repo, webhookUrl, config.webhookSecret, config);
	}
}

export async function registerRepo(
	repo: string,
	config: DaemonConfig,
): Promise<void> {
	if (config.repos.includes(repo)) return;

	config.repos.push(repo);
	saveConfig(config);
	log('info', `Registered repo: ${repo}`);

	const webhookUrl = config.publicUrl
		? `${config.publicUrl}/webhooks/github`
		: config.tunnel
			? `https://${config.tunnel.hostname}/webhooks/github`
			: null;

	if (webhookUrl) {
		await ensureWebhook(repo, webhookUrl, config.webhookSecret, config);
	}
}

export async function unregisterRepo(
	repo: string,
	config: DaemonConfig,
): Promise<void> {
	const idx = config.repos.indexOf(repo);
	if (idx === -1) return;

	// Remove webhook
	const hookId = config.webhooks[repo];
	if (hookId) {
		await ghAsync('api', `repos/${repo}/hooks/${hookId}`, '-X', 'DELETE');
		delete config.webhooks[repo];
	}

	config.repos.splice(idx, 1);
	saveConfig(config);
	log('info', `Unregistered repo: ${repo}`);
}

/**
 * Per-repo orphan: an "owned" hook (matches isOwnedHook) other than the one
 * the daemon is currently tracking in config.webhooks[repo].
 */
export type OrphanWebhook = {
	repo: string;
	hookId: number;
	url: string;
};

/**
 * For each registered repo, list owned hooks and return any that are NOT the
 * one currently tracked in config.webhooks. Used by `st daemon repo doctor`.
 */
export async function findAllOrphans(config: DaemonConfig): Promise<OrphanWebhook[]> {
	const out: OrphanWebhook[] = [];
	for (const repo of config.repos) {
		const hooks = await listHooks(repo);
		if (!hooks) continue;
		const tracked = config.webhooks[repo];
		for (const h of hooks) {
			if (!isOwnedHook(h)) continue;
			if (h.id === tracked) continue;
			out.push({ repo, hookId: h.id, url: h.config.url ?? '' });
		}
	}
	return out;
}

/** DELETE /repos/{repo}/hooks/{id}. Returns true on success. */
export async function deleteHook(repo: string, hookId: number): Promise<boolean> {
	const result = await ghAsync('api', `repos/${repo}/hooks/${hookId}`, '-X', 'DELETE');
	if (!result.ok) {
		log('error', `Failed to delete hook ${hookId} for ${repo}: ${result.stderr}`);
	}
	return result.ok;
}
