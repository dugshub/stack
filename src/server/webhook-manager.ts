import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './log.js';
import { ghAsync } from './spawn.js';
import type { DaemonConfig } from './types.js';

const CONFIG_PATH = join(homedir(), '.claude', 'stacks', 'server.config.json');

const WEBHOOK_EVENTS = ['pull_request', 'push', 'check_suite', 'check_run'];

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
		// Webhook was deleted externally — fall through to create
		delete config.webhooks[repo];
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
