import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executeActions } from './actions.js';
import { ensureClone } from './clone.js';
import { processEvent } from './engine.js';
import { findJobForPR, loadAllJobs, loadJob, saveJob } from './state.js';
import type { MergeJob, ServerConfig } from './types.js';
import { handlePushEvent } from './rebase-check.js';
import { parseWebhook, verifySignature } from './webhook.js';

const sseClients = new Map<string, Set<WritableStreamDefaultWriter>>();

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
	config: ServerConfig,
): Promise<Response> {
	const body = await req.text();
	const signature = req.headers.get('x-hub-signature-256') ?? '';
	const eventType = req.headers.get('x-github-event') ?? '';

	const valid = await verifySignature(body, signature, config.webhookSecret);
	if (!valid) {
		return new Response('invalid signature', { status: 401 });
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response('invalid json', { status: 400 });
	}

	const event = parseWebhook(eventType, payload);
	if (!event) {
		return new Response('ok');
	}

	// Push events go to the rebase check handler (fire-and-forget)
	if (event.type === 'push') {
		handlePushEvent(event).catch((err) => {
			console.error('Rebase check failed:', err);
		});
		return new Response('ok');
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
			pushSSE(job.id, {
				type: 'notify',
				message: (actionResult.action as { message: string }).message,
				level: (actionResult.action as { level: string }).level,
			});
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

function loadServerConfig(): ServerConfig {
	const configPath = join(
		homedir(),
		'.claude',
		'stacks',
		'server.config.json',
	);
	try {
		const text = readFileSync(configPath, 'utf-8');
		return JSON.parse(text) as ServerConfig;
	} catch {
		return {
			port: 7654,
			webhookSecret: '',
		};
	}
}

export function startServer(config?: ServerConfig): ReturnType<typeof Bun.serve> {
	const cfg = config ?? loadServerConfig();

	const server = Bun.serve({
		port: cfg.port,
		async fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === '/webhooks/github' && req.method === 'POST') {
				return handleWebhook(req, cfg);
			}
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
			if (url.pathname === '/health') {
				return new Response('ok');
			}
			return new Response('not found', { status: 404 });
		},
	});

	console.log(`Stack merge server listening on port ${cfg.port}`);
	return server;
}

// Auto-start when run directly
if (import.meta.main) {
	startServer();
}
