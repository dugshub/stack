import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonConfig } from './types.js';
import { ghAsync } from './spawn.js';

const CONFIG_PATH = join(homedir(), '.claude', 'stacks', 'server.config.json');

const WEBHOOK_EVENTS = ['pull_request', 'push', 'check_suite', 'check_run'];

function saveConfig(config: DaemonConfig): void {
	mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
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
		// Verify webhook still exists and has correct events
		const check = await ghAsync('api', `repos/${repo}/hooks/${existingId}`, '--jq', '.id');
		if (check.ok) {
			// Patch to ensure correct events
			const patchPayload = JSON.stringify({ events: WEBHOOK_EVENTS });
			const tmpPatchFile = join(homedir(), '.claude', 'stacks', `webhook-patch-${Date.now()}.json`);
			writeFileSync(tmpPatchFile, patchPayload, 'utf-8');
			await ghAsync(
				'api', `repos/${repo}/hooks/${existingId}`,
				'--method', 'PATCH',
				'--input', tmpPatchFile,
			);
			try { unlinkSync(tmpPatchFile); } catch { /* ignore */ }
			// Even if patch fails, webhook exists
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
		console.error(`Webhook creation failed for ${repo}: ${result.stderr}`);
		return null;
	}

	const hookId = Number.parseInt(result.stdout.trim(), 10);
	if (Number.isNaN(hookId)) {
		console.error(`Could not parse webhook ID from: ${result.stdout}`);
		return null;
	}

	config.webhooks[repo] = hookId;
	saveConfig(config);
	console.log(`Webhook created for ${repo} (id: ${hookId})`);
	return hookId;
}

export async function syncWebhooks(config: DaemonConfig): Promise<void> {
	const webhookUrl = config.publicUrl
		? `${config.publicUrl}/webhooks/github`
		: config.tunnel
			? `https://${config.tunnel.hostname}/webhooks/github`
			: null;

	if (!webhookUrl) {
		console.log('No public URL or tunnel configured — skipping webhook sync');
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
	console.log(`Registered repo: ${repo}`);

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
	console.log(`Unregistered repo: ${repo}`);
}
