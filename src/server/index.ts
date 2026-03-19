import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executeActions } from './actions.js';
import { cacheToJson, getCachedPr, getCachedPrs, isCacheStale, refreshCache, updateCachedPr } from './cache.js';
import { ensureClone } from './clone.js';
import { processEvent } from './engine.js';
import { findJobForPR, loadAllJobs, loadJob, saveJob } from './state.js';
import { startTunnel, stopTunnel, isTunnelRunning, getTunnelRestartCount } from './tunnel.js';
import type { DaemonConfig, MergeJob } from './types.js';
import { handlePushEvent, handlePRMergedEvent } from './stack-checks.js';
import { parseWebhook, verifySignature } from './webhook.js';
import { registerRepo, unregisterRepo, syncWebhooks } from './webhook-manager.js';

const sseClients = new Map<string, Set<WritableStreamDefaultWriter>>();
const daemonStartTime = Date.now();
let daemonToken: string | null = null;

function ensureDaemonToken(): string {
	const tokenPath = join(homedir(), '.claude', 'stacks', 'daemon.token');
	if (existsSync(tokenPath)) {
		return readFileSync(tokenPath, 'utf-8').trim();
	}
	const token = crypto.randomUUID();
	mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
	writeFileSync(tokenPath, token, 'utf-8');
	return token;
}

function checkAuth(req: Request): boolean {
	if (!daemonToken) return true;
	const auth = req.headers.get('Authorization');
	if (!auth) return false;
	const token = auth.replace('Bearer ', '');
	return token === daemonToken;
}

function pushSSE(jobId: string, data: Record<string, unknown>): void {
	const clients = sseClients.get(jobId);
	if (!clients) return;
	const message = `data: ${JSON.stringify(data)}\n\n`;
	for (const writer of clients) {
		writer.write(new TextEncoder().encode(message)).catch(() => {
			clients.delete(writer);
		});
	}
}

function repoUrl(repo: string): string {
	return `https://github.com/${repo}.git`;
}

function repoName(repo: string): string {
	return repo.replace('/', '-');
}

async function handleWebhook(
	req: Request,
	config: DaemonConfig,
): Promise<Response> {
	const body = await req.text();
	const signature = req.headers.get('x-hub-signature-256') ?? '';
	const eventType = req.headers.get('x-github-event') ?? '';

	console.log(`Webhook received: ${eventType}`);

	const valid = await verifySignature(body, signature, config.webhookSecret);
	if (!valid) {
		console.log('Webhook signature verification failed');
		return new Response('invalid signature', { status: 401 });
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response('invalid json', { status: 400 });
	}

	const event = parseWebhook(eventType, payload);

	// Update cache from raw webhook payload (broader than engine events)
	updateCacheFromWebhook(eventType, payload);

	if (!event) {
		return new Response('ok');
	}

	// Push events go to the rebase check handler (fire-and-forget)
	if (event.type === 'push') {
		console.log(`Push event: ${event.branch} (${event.headSha.slice(0, 7)})`);
		handlePushEvent(event).catch((err) => {
			console.error('Rebase check failed:', err);
		});
		return new Response('ok');
	}

	// Always re-evaluate merge-ready statuses when a PR merges,
	// even if there's an active merge job — the job's cascade may
	// fail and leave stale "failure" statuses on remaining PRs.
	if (event.type === 'pr_merged') {
		handlePRMergedEvent(event).catch((err) => {
			console.error('Merge-ready update failed:', err);
		});
	}

	const job = findJobForPR(event.repo, event.prNumber);
	if (!job) {
		return new Response('ok');
	}

	// Process event through engine — job may be in 'rebasing-next' state
	const result = processEvent(job, event);

	// Save state FIRST for crash safety (captures 'rebasing-next' to disk)
	saveJob(result.job);

	// Push initial event to SSE
	pushSSE(job.id, {
		type: 'state',
		job: result.job,
	});

	// Execute actions asynchronously
	const clonePath = await ensureClone(
		repoUrl(result.job.repo),
		repoName(result.job.repo),
	);
	const actionResults = await executeActions(result.actions, { clonePath });

	// Check for action failures
	const failed = actionResults.find((r) => !r.ok);
	if (failed) {
		result.job.status = 'failed';
		const step = result.job.steps[result.job.currentStep];
		if (step) {
			step.status = 'failed';
			step.error = failed.error ?? 'Action execution failed';
		}
		result.job.pendingNextStep = undefined;
		saveJob(result.job);

		pushSSE(job.id, {
			type: 'error',
			message: failed.error ?? 'Action execution failed',
			job: result.job,
		});
	} else if (result.job.pendingNextStep != null) {
		// Actions succeeded — finalize the rebasing-next -> done transition
		const prevStep = result.job.steps[result.job.currentStep];
		if (prevStep) {
			prevStep.status = 'done';
		}
		const nextIndex = result.job.pendingNextStep;
		result.job.currentStep = nextIndex;
		const nextStep = result.job.steps[nextIndex];
		if (nextStep) {
			nextStep.status = 'auto-merge-enabled';
		}
		result.job.pendingNextStep = undefined;
		saveJob(result.job);
	}

	// Push action results to SSE
	for (const actionResult of actionResults) {
		if (actionResult.action.type === 'notify') {
			const { message, level } = actionResult.action;
			pushSSE(job.id, { type: 'notify', message, level });
		}
	}

	// If job completed or failed, close SSE connections
	if (result.job.status === 'completed' || result.job.status === 'failed') {
		pushSSE(job.id, { type: 'done', job: result.job });
		const clients = sseClients.get(job.id);
		if (clients) {
			for (const writer of clients) {
				writer.close().catch(() => {});
			}
			sseClients.delete(job.id);
		}
	}

	return new Response('ok');
}

async function handleCreateJob(req: Request): Promise<Response> {
	let body: MergeJob;
	try {
		body = (await req.json()) as MergeJob;
	} catch {
		return Response.json({ error: 'invalid json' }, { status: 400 });
	}

	if (!body.id || !body.stackName || !body.steps || body.steps.length === 0) {
		return Response.json({ error: 'invalid job' }, { status: 400 });
	}

	saveJob(body);

	// Ensure bare clone exists
	const clonePath = await ensureClone(
		repoUrl(body.repo),
		repoName(body.repo),
	);

	// Enable auto-merge on the first PR
	const firstStep = body.steps[0];
	if (firstStep) {
		const results = await executeActions(
			[
				{
					type: 'enable-auto-merge',
					prNumber: firstStep.prNumber,
					strategy: body.strategy,
				},
			],
			{ clonePath },
		);

		const failed = results.find((r) => !r.ok);
		if (failed) {
			body.status = 'failed';
			firstStep.status = 'failed';
			firstStep.error = failed.error ?? 'Failed to enable auto-merge';
			saveJob(body);
			return Response.json({ job: body, error: failed.error }, { status: 500 });
		}

		firstStep.status = 'auto-merge-enabled';
		saveJob(body);
	}

	return Response.json({ job: body }, { status: 201 });
}

function handleGetJob(req: Request): Response {
	const url = new URL(req.url);
	const id = url.pathname.split('/').pop();
	if (!id) {
		return Response.json({ error: 'missing id' }, { status: 400 });
	}

	const job = loadJob(id);
	if (!job) {
		return Response.json({ error: 'not found' }, { status: 404 });
	}

	return Response.json({ job });
}

function handleListJobs(): Response {
	const jobs = loadAllJobs();
	return Response.json({ jobs: Object.values(jobs) });
}

function handleSSE(req: Request): Response {
	const url = new URL(req.url);
	const parts = url.pathname.split('/');
	// /api/jobs/:id/events -> id is at index -2
	const id = parts[parts.length - 2];
	if (!id) {
		return Response.json({ error: 'missing id' }, { status: 400 });
	}

	const job = loadJob(id);
	if (!job) {
		return Response.json({ error: 'not found' }, { status: 404 });
	}

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	if (!sseClients.has(id)) {
		sseClients.set(id, new Set());
	}
	sseClients.get(id)?.add(writer);

	// Send current state immediately
	const initial = `data: ${JSON.stringify({ type: 'state', job })}\n\n`;
	writer.write(new TextEncoder().encode(initial)).catch(() => {});

	// If the job is already done, close immediately after sending state
	if (job.status === 'completed' || job.status === 'failed') {
		const done = `data: ${JSON.stringify({ type: 'done', job })}\n\n`;
		writer.write(new TextEncoder().encode(done)).then(() => {
			writer.close().catch(() => {});
			sseClients.get(id)?.delete(writer);
		}).catch(() => {});
	}

	// Clean up on abort
	req.signal.addEventListener('abort', () => {
		sseClients.get(id)?.delete(writer);
		writer.close().catch(() => {});
	});

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

function updateCacheFromWebhook(eventType: string, payload: unknown): void {
	const data = payload as Record<string, unknown>;
	const repo = (data.repository as { full_name?: string })?.full_name;
	if (!repo) return;

	if (eventType === 'pull_request') {
		const pr = data.pull_request as {
			number: number;
			title?: string;
			state?: string;
			draft?: boolean;
			merged?: boolean;
			html_url?: string;
		} | undefined;
		if (!pr) return;
		const action = data.action as string;

		if (action === 'closed') {
			updateCachedPr(repo, pr.number, {
				state: pr.merged ? 'MERGED' : 'CLOSED',
			});
		} else if (action === 'synchronize') {
			updateCachedPr(repo, pr.number, { checksStatus: 'PENDING' });
		} else if (action === 'ready_for_review') {
			updateCachedPr(repo, pr.number, { isDraft: false });
		} else if (action === 'converted_to_draft') {
			updateCachedPr(repo, pr.number, { isDraft: true });
		} else if (action === 'opened' || action === 'reopened') {
			updateCachedPr(repo, pr.number, {
				title: pr.title ?? '',
				state: 'OPEN',
				isDraft: pr.draft ?? false,
				url: pr.html_url ?? '',
			});
		}
	}

	if (eventType === 'check_suite' || eventType === 'check_run') {
		const suite = (eventType === 'check_suite'
			? data.check_suite
			: data.check_run) as {
			conclusion: string | null;
			status: string;
			pull_requests?: Array<{ number: number }>;
		} | undefined;
		if (!suite?.pull_requests) return;

		for (const pr of suite.pull_requests) {
			let checksStatus: 'SUCCESS' | 'FAILURE' | 'PENDING' = 'PENDING';
			if (suite.conclusion === 'success') checksStatus = 'SUCCESS';
			else if (suite.conclusion === 'failure' || suite.conclusion === 'cancelled') checksStatus = 'FAILURE';
			else if (suite.status === 'completed' && suite.conclusion) checksStatus = suite.conclusion === 'success' ? 'SUCCESS' : 'FAILURE';
			updateCachedPr(repo, pr.number, { checksStatus });
		}
	}
}

function loadDaemonConfig(): DaemonConfig {
	const configPath = join(
		homedir(),
		'.claude',
		'stacks',
		'server.config.json',
	);
	try {
		const text = readFileSync(configPath, 'utf-8');
		const raw = JSON.parse(text) as Record<string, unknown>;
		const config: DaemonConfig = {
			port: (raw.port as number) ?? 7654,
			webhookSecret: (raw.webhookSecret as string) ?? '',
			publicUrl: raw.publicUrl as string | undefined,
			tunnel: raw.tunnel as DaemonConfig['tunnel'],
			webhooks: (raw.webhooks as Record<string, number>) ?? {},
			repos: (raw.repos as string[]) ?? [],
		};
		// Migrate: if old format missing new fields, write back
		if (!raw.webhooks || !raw.repos) {
			const { writeFileSync: writeSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
			mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
			writeSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
		}
		return config;
	} catch {
		return {
			port: 7654,
			webhookSecret: '',
			webhooks: {},
			repos: [],
		};
	}
}

export function startServer(config?: DaemonConfig): ReturnType<typeof Bun.serve> {
	const cfg = config ?? loadDaemonConfig();

	const server = Bun.serve({
		port: cfg.port,
		idleTimeout: 120, // seconds — webhook handlers may fetch/rebase which takes time
		async fetch(req) {
			const url = new URL(req.url);

			// No-auth routes
			if (url.pathname === '/health') {
				return new Response('ok');
			}
			if (url.pathname === '/webhooks/github' && req.method === 'POST') {
				return handleWebhook(req, cfg);
			}

			// All /api/* routes require bearer token auth
			if (url.pathname.startsWith('/api/')) {
				if (!checkAuth(req)) {
					return Response.json({ error: 'unauthorized' }, { status: 401 });
				}
			}

			// Daemon status
			if (url.pathname === '/api/status' && req.method === 'GET') {
				const jobs = loadAllJobs();
				const activeJobs = Object.values(jobs).filter(
					(j) => j.status === 'running',
				).length;
				return Response.json({
					running: true,
					pid: process.pid,
					port: cfg.port,
					uptime: Date.now() - daemonStartTime,
					tunnel: cfg.tunnel
						? {
								running: isTunnelRunning(),
								hostname: cfg.tunnel.hostname,
								restarts: getTunnelRestartCount(),
							}
						: null,
					repos: cfg.repos,
					activeJobs,
				});
			}

			// Register repo
			if (url.pathname === '/api/repos' && req.method === 'POST') {
				const body = (await req.json()) as { repo?: string };
				if (!body.repo) {
					return Response.json({ error: 'missing repo' }, { status: 400 });
				}
				await registerRepo(body.repo, cfg);
				return Response.json({ ok: true });
			}

			// Unregister repo
			const repoDeleteMatch = url.pathname.match(
				/^\/api\/repos\/(.+)$/,
			);
			if (repoDeleteMatch && req.method === 'DELETE') {
				const repo = decodeURIComponent(repoDeleteMatch[1] as string);
				await unregisterRepo(repo, cfg);
				return Response.json({ ok: true });
			}

			// PR cache — all PRs for a repo
			const cacheMatch = url.pathname.match(
				/^\/api\/cache\/([^/]+)\/([^/]+)\/prs$/,
			);
			if (cacheMatch && req.method === 'GET') {
				const owner = cacheMatch[1] as string;
				const repoName = cacheMatch[2] as string;
				const fullRepo = `${owner}/${repoName}`;
				// Background refresh if stale
				if (isCacheStale(fullRepo)) {
					refreshCache(fullRepo).catch((err) => {
						console.error(`Cache refresh failed for ${fullRepo}:`, err);
					});
				}
				return Response.json(cacheToJson(fullRepo));
			}

			// Single PR cache entry
			const prCacheMatch = url.pathname.match(
				/^\/api\/cache\/([^/]+)\/([^/]+)\/pr\/(\d+)$/,
			);
			if (prCacheMatch && req.method === 'GET') {
				const owner = prCacheMatch[1] as string;
				const repoName = prCacheMatch[2] as string;
				const prNum = Number(prCacheMatch[3]);
				const fullRepo = `${owner}/${repoName}`;
				const pr = getCachedPr(fullRepo, prNum);
				if (!pr) {
					return Response.json({ error: 'not found' }, { status: 404 });
				}
				return Response.json(pr);
			}

			// Existing job routes
			if (url.pathname === '/api/jobs' && req.method === 'POST') {
				return handleCreateJob(req);
			}
			if (
				url.pathname.match(/^\/api\/jobs\/[\w-]+\/events$/) &&
				req.method === 'GET'
			) {
				return handleSSE(req);
			}
			if (
				url.pathname.match(/^\/api\/jobs\/[\w-]+$/) &&
				req.method === 'GET'
			) {
				return handleGetJob(req);
			}
			if (url.pathname === '/api/jobs' && req.method === 'GET') {
				return handleListJobs();
			}

			return new Response('not found', { status: 404 });
		},
	});

	console.log(`Stack daemon listening on port ${cfg.port}`);
	return server;
}

// Auto-start when run directly
if (import.meta.main) {
	// Generate/load daemon token
	daemonToken = ensureDaemonToken();
	console.log('Daemon token loaded');

	// Clean up old server.pid if present
	const oldPidFile = join(homedir(), '.claude', 'stacks', 'server.pid');
	if (existsSync(oldPidFile)) {
		try { unlinkSync(oldPidFile); } catch { /* ignore */ }
	}

	const config = loadDaemonConfig();
	const server = startServer(config);

	// Start tunnel if configured
	if (config.tunnel) {
		startTunnel(config);
	}

	// Sync webhooks for all watched repos (fire-and-forget)
	syncWebhooks(config).catch((err) => {
		console.error('Webhook sync failed:', err);
	});

	// Graceful shutdown
	const shutdown = (): void => {
		console.log('Shutting down daemon...');
		stopTunnel();
		server.stop(true);
		// Clean up PID file
		const pidFile = join(homedir(), '.claude', 'stacks', 'daemon.pid');
		try { unlinkSync(pidFile); } catch { /* ignore */ }
		process.exit(0);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}
