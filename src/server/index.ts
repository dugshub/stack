import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cacheToJson, getCachedPr, isCacheStale, refreshCache, updateCachedPr } from './cache.js';
import { ensureClone, fetchClone, rebaseInWorktree, getBranchSha, pushBranch } from './clone.js';
import { log, setForeground, addLogClient, removeLogClient } from './log.js';
import { acquireLock, releaseLock, isStackLocked, activeLockCount, listActiveLocks } from './locks.js';
import { startTunnel, stopTunnel, isTunnelRunning, getTunnelRestartCount } from './tunnel.js';
import type { DaemonConfig } from './types.js';
import {
	handlePushEvent,
	handlePRMergedEvent,
	loadStackStateForRepo,
	findStackForPR,
	saveStackStateForRepo,
	findDependentStacks,
	parentsOf,
	type StackFile,
} from './stack-checks.js';
import { ghAsync, gitAsync } from './spawn.js';
import { parseWebhook, verifySignature } from './webhook.js';
import { registerRepo, unregisterRepo, syncWebhooks } from './webhook-manager.js';

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

function repoUrl(repo: string): string {
	return `https://github.com/${repo}.git`;
}

function repoName(repo: string): string {
	return repo.replace('/', '-');
}

// --- New webhook handlers (replaces engine/actions/state) ---

async function handlePRMerged(repo: string, prNumber: number): Promise<void> {
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

	// Capture merged-branch context BEFORE any state mutation. These stay
	// valid after the splice below and are used by `cascadeToDependents`.
	const mergedBranch = stack.branches[branchIndex];
	const oldBase = mergedBranch?.tip;
	const mergedName = mergedBranch?.name;
	const parentTrunk = stack.trunk;

	// Find remaining unmerged branches after this one
	const remaining = stack.branches.slice(branchIndex + 1);
	if (remaining.length === 0) {
		log('success', `Stack "${stackName}" fully merged`, stackName);
		if (oldBase && mergedName) {
			try {
				await cascadeToDependents(repo, state, stackName, mergedName, oldBase, parentTrunk);
			} catch (err) {
				log('error', `Dependent cascade failed: ${err}`, stackName);
			}
		}
		return;
	}

	const nextBranch = remaining[0];
	if (!nextBranch?.pr) return;

	if (!oldBase) {
		log('error', 'Missing branch tip for rebase — cannot cascade', stackName);
		return;
	}

	// ── Cascade: rebase → push → retarget ──
	const I = true; // indent flag for cascade block

	const clonePath = await ensureClone(repoUrl(repo), repoName(repo));
	log('info', `git fetch origin`, stackName, 'git', I);
	await fetchClone(clonePath);

	const preSha = await getBranchSha(clonePath, nextBranch.name);
	log('info', `git rebase --onto ${stack.trunk} ${oldBase.slice(0, 7)} ${nextBranch.name}`, stackName, 'git', I);
	const rebaseResult = await rebaseInWorktree(clonePath, {
		branch: nextBranch.name,
		onto: stack.trunk,
		oldBase,
	});
	if (!rebaseResult.ok) {
		log('error', `Rebase failed for ${nextBranch.name}: ${rebaseResult.error}`, stackName, undefined, I);
		return;
	}
	log('success', `Rebased ${nextBranch.name} onto ${stack.trunk}`, stackName, undefined, I);

	// Update state before push so the push webhook handler reads correct parent info.
	// Get the post-rebase SHA from the bare clone (rebase updated the ref in place).
	const postRebaseSha = await getBranchSha(clonePath, nextBranch.name);
	stack.branches.splice(branchIndex, 1);
	nextBranch.tip = postRebaseSha;
	saveStackStateForRepo(repo, state);

	log('info', `git push --force-with-lease ${nextBranch.name} (${preSha.slice(0, 7)})`, stackName, 'git', I);
	const pushResult = await pushBranch(clonePath, nextBranch.name, preSha);
	if (!pushResult.ok) {
		log('error', `Push failed for ${nextBranch.name}: ${pushResult.error}`, stackName, undefined, I);
		return;
	}
	const newSha = await getBranchSha(clonePath, nextBranch.name);
	log('success', `Pushed ${nextBranch.name} (${preSha.slice(0, 7)} → ${newSha.slice(0, 7)})`, stackName, undefined, I);

	// Post rebase-status check
	log('info', `POST statuses/${newSha.slice(0, 7)} — rebase-status=success`, stackName, 'api', I);
	await ghAsync(
		'api', `repos/${repo}/statuses/${newSha}`,
		'-f', 'state=success', '-f', 'context=stack/rebase-status',
		'-f', `description=Rebased on ${stack.trunk}`,
	);

	// Retarget PR to trunk
	log('info', `gh pr edit #${nextBranch.pr} --base ${stack.trunk}`, stackName, 'api', I);
	await ghAsync('pr', 'edit', String(nextBranch.pr), '--base', stack.trunk);
	log('success', `Retargeted #${nextBranch.pr} to ${stack.trunk}`, stackName, undefined, I);

	if (mergedName) {
		try {
			await cascadeToDependents(repo, state, stackName, mergedName, oldBase, parentTrunk);
		} catch (err) {
			log('error', `Dependent cascade failed: ${err}`, stackName);
		}
	}
}

/**
 * After handling the in-stack cascade for a merged PR, find every stack that
 * depends on the merged branch and rebase its first branch onto the parent's
 * trunk (then cascade through the rest of that stack).
 *
 * Phase-1 scope: single-parent dependents only. Multi-parent (diamond)
 * dependents are logged and skipped — user recovers with `st sync`.
 */
async function cascadeToDependents(
	repo: string,
	state: StackFile,
	parentStackName: string,
	mergedBranchName: string,
	mergedBranchTip: string,
	parentTrunk: string,
): Promise<void> {
	const dependents = findDependentStacks(state, parentStackName, mergedBranchName);
	if (dependents.length === 0) return;

	const I = true;
	const clonePath = await ensureClone(repoUrl(repo), repoName(repo));
	// In the fully-merged path we short-circuited before fetching. Fetch once
	// here to cover that case — fetchClone is serialised per clone path.
	log('info', `git fetch origin`, parentStackName, 'git', I);
	await fetchClone(clonePath);

	for (const { stackName: depName, stack: depStack } of dependents) {
		// Phase-1: skip diamond dependents.
		if (parentsOf(depStack).length > 1) {
			log(
				'warn',
				`Dependent stack "${depName}" has multiple parents — skipping (run \`st sync\` manually).`,
				depName,
			);
			continue;
		}

		if (isStackLocked(depName)) {
			log('info', `Stack "${depName}" locked by CLI — skipping dependent sync`, depName);
			continue;
		}

		const firstBranch = depStack.branches[0];
		if (!firstBranch) {
			log('warn', `Dependent "${depName}" has no branches — skipping`, depName);
			continue;
		}

		log(
			'info',
			`Cascading to dependent stack "${depName}" — rebasing ${firstBranch.name} onto ${parentTrunk}`,
			depName,
		);

		const preSha = await getBranchSha(clonePath, firstBranch.name);

		// Resolve the effective `oldBase` for rebase --onto. Prefer the
		// stored `mergedBranchTip`; if it's not an ancestor of the
		// dependent's first branch (state drift), fall back to the
		// `merge-base parentTrunk firstBranch`.
		let effectiveOldBase = mergedBranchTip;
		const ancestor = await gitAsync(
			['merge-base', '--is-ancestor', mergedBranchTip, firstBranch.name],
			{ cwd: clonePath },
		);
		if (!ancestor.ok) {
			const mbRes = await gitAsync(
				['merge-base', parentTrunk, firstBranch.name],
				{ cwd: clonePath },
			);
			if (mbRes.ok && mbRes.stdout.trim()) {
				effectiveOldBase = mbRes.stdout.trim();
				log(
					'warn',
					`Stored tip ${mergedBranchTip.slice(0, 7)} not on ${firstBranch.name} — falling back to merge-base ${effectiveOldBase.slice(0, 7)}`,
					depName,
					undefined,
					I,
				);
			}
		}

		log(
			'info',
			`git rebase --onto ${parentTrunk} ${effectiveOldBase.slice(0, 7)} ${firstBranch.name}`,
			depName,
			'git',
			I,
		);
		const rebase = await rebaseInWorktree(clonePath, {
			branch: firstBranch.name,
			onto: parentTrunk,
			oldBase: effectiveOldBase,
		});
		if (!rebase.ok) {
			log('error', `Rebase failed for ${firstBranch.name}: ${rebase.error}`, depName, undefined, I);
			continue;
		}
		log('success', `Rebased ${firstBranch.name} onto ${parentTrunk}`, depName, undefined, I);

		// Update state first so any follow-up webhook reads the new parent.
		const postSha = await getBranchSha(clonePath, firstBranch.name);
		const parentTrunkSha = await getBranchSha(clonePath, parentTrunk);
		firstBranch.tip = postSha;
		firstBranch.parentTip = parentTrunkSha;
		depStack.trunk = parentTrunk;
		// Remove the merged-parent entry from dependsOn; save collapses shapes.
		const remainingParents = parentsOf(depStack).filter(
			(p) => !(p.stack === parentStackName && p.branch === mergedBranchName),
		);
		if (remainingParents.length === 0) {
			delete depStack.dependsOn;
		} else {
			depStack.dependsOn = remainingParents;
		}
		saveStackStateForRepo(repo, state);

		log(
			'info',
			`git push --force-with-lease ${firstBranch.name} (${preSha.slice(0, 7)})`,
			depName,
			'git',
			I,
		);
		const push = await pushBranch(clonePath, firstBranch.name, preSha);
		if (!push.ok) {
			log('error', `Push failed for ${firstBranch.name}: ${push.error}`, depName, undefined, I);
			continue;
		}
		const newSha = await getBranchSha(clonePath, firstBranch.name);
		log(
			'success',
			`Pushed ${firstBranch.name} (${preSha.slice(0, 7)} → ${newSha.slice(0, 7)})`,
			depName,
			undefined,
			I,
		);

		// rebase-status success
		log(
			'info',
			`POST statuses/${newSha.slice(0, 7)} — rebase-status=success`,
			depName,
			'api',
			I,
		);
		await ghAsync(
			'api',
			`repos/${repo}/statuses/${newSha}`,
			'-f',
			'state=success',
			'-f',
			'context=stack/rebase-status',
			'-f',
			`description=Rebased on ${parentTrunk}`,
		);

		// Retarget first branch's PR to the new trunk.
		if (firstBranch.pr) {
			log('info', `gh pr edit #${firstBranch.pr} --base ${parentTrunk}`, depName, 'api', I);
			await ghAsync('pr', 'edit', String(firstBranch.pr), '--base', parentTrunk);
			log('success', `Retargeted #${firstBranch.pr} to ${parentTrunk}`, depName, undefined, I);
		}

		// Cascade through the rest of depStack's branches. For branch at
		// index `i`, the correct `--onto` exclusion SHA is the PARENT's
		// (prev's) OLD tip — the commit prev was at BEFORE we rebased it.
		// Seed the map with firstBranch's pre-rebase SHA and each
		// subsequent branch's stored (pre-cascade) tip.
		const oldTips = new Map<string, string>();
		oldTips.set(firstBranch.name, preSha);
		for (let i = 1; i < depStack.branches.length; i++) {
			const b = depStack.branches[i];
			if (!b) continue;
			if (b.tip) {
				oldTips.set(b.name, b.tip);
			} else {
				const sha = await getBranchSha(clonePath, b.name).catch(() => '');
				if (sha) oldTips.set(b.name, sha);
			}
		}

		for (let i = 1; i < depStack.branches.length; i++) {
			const b = depStack.branches[i];
			const prev = depStack.branches[i - 1];
			if (!b || !prev) continue;
			const oldPrevTip = oldTips.get(prev.name); // PREVIOUS branch's OLD tip
			if (!oldPrevTip) {
				log(
					'warn',
					`No old tip recorded for ${prev.name} — skipping cascade at this link`,
					depName,
				);
				break;
			}
			const bPre = await getBranchSha(clonePath, b.name);
			log(
				'info',
				`git rebase --onto ${prev.name} ${oldPrevTip.slice(0, 7)} ${b.name}`,
				depName,
				'git',
				I,
			);
			const r = await rebaseInWorktree(clonePath, {
				branch: b.name,
				onto: prev.name,
				oldBase: oldPrevTip,
			});
			if (!r.ok) {
				log('error', `Rebase failed for ${b.name}: ${r.error}`, depName, undefined, I);
				break;
			}
			const postBSha = await getBranchSha(clonePath, b.name);
			const newPrevTip = await getBranchSha(clonePath, prev.name);
			b.tip = postBSha;
			b.parentTip = newPrevTip;
			saveStackStateForRepo(repo, state);
			log('info', `git push --force-with-lease ${b.name}`, depName, 'git', I);
			const rp = await pushBranch(clonePath, b.name, bPre);
			if (!rp.ok) {
				log('error', `Push failed for ${b.name}: ${rp.error}`, depName, undefined, I);
				break;
			}
			// rebase-status success (branch is on top of its new parent)
			const sha = await getBranchSha(clonePath, b.name);
			await ghAsync(
				'api',
				`repos/${repo}/statuses/${sha}`,
				'-f',
				'state=success',
				'-f',
				'context=stack/rebase-status',
				'-f',
				`description=Rebased on ${prev.name}`,
			);
		}

		log('success', `Dependent stack "${depName}" synced onto ${parentTrunk}`, depName);
	}
}

// --- Webhook handler ---

async function handleWebhook(
	req: Request,
	config: DaemonConfig,
): Promise<Response> {
	const body = await req.text();
	const signature = req.headers.get('x-hub-signature-256') ?? '';
	const eventType = req.headers.get('x-github-event') ?? '';

	const valid = await verifySignature(body, signature, config.webhookSecret);
	if (!valid) {
		log('error', 'Webhook signature verification failed');
		return new Response('invalid signature', { status: 401 });
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response('invalid json', { status: 400 });
	}

	const event = parseWebhook(eventType, payload);

	// Update cache from raw webhook payload (check_run/check_suite are cache-only, don't log)
	updateCacheFromWebhook(eventType, payload);

	if (!event) {
		return new Response('ok');
	}

	// Push events go to the rebase check handler (fire-and-forget)
	if (event.type === 'push') {
		log('info', `push: ${event.branch} (${event.headSha.slice(0, 7)})`, undefined, 'webhook');
		handlePushEvent(event).catch((err) => {
			log('error', `Rebase check failed: ${err}`);
		});
		return new Response('ok');
	}

	// PR merged — update merge-ready statuses + cascade
	if (event.type === 'pr_merged') {
		log('info', `pull_request: #${event.prNumber} merged`, undefined, 'webhook');
		handlePRMergedEvent(event).catch((err) => {
			log('error', `Merge-ready update failed: ${err}`);
		});
		handlePRMerged(event.repo, event.prNumber).catch((err) => {
			log('error', `Merge cascade failed: ${err}`);
		});
		return new Response('ok');
	}

	// PR closed without merge
	if (event.type === 'pr_closed') {
		log('info', `pull_request: #${event.prNumber} closed`, undefined, 'webhook');
		return new Response('ok');
	}


	return new Response('ok');
}

// --- Cache update from webhook ---

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

// --- Config ---

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
			mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
			writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
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

// --- Server ---

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
					activeLocks: activeLockCount(),
				});
			}

			// Log stream (SSE)
			if (url.pathname === '/api/logs' && req.method === 'GET') {
				const stackFilter = url.searchParams.get('stack') ?? undefined;
				const { readable, writable } = new TransformStream();
				const writer = writable.getWriter();
				addLogClient(writer);

				// Emit a keepalive comment every 30s so idle connections
				// don't get closed by the server's idleTimeout (120s) or
				// any intermediary proxy.
				const keepaliveBytes = new TextEncoder().encode(': keepalive\n\n');
				const keepalive = setInterval(() => {
					writer.write(keepaliveBytes).catch(() => {
						clearInterval(keepalive);
					});
				}, 30_000);

				if (stackFilter) {
					const filteredWriter = new Proxy(writer, {
						get(target, prop) {
							if (prop === 'write') {
								return (chunk: Uint8Array) => {
									const text = new TextDecoder().decode(chunk);
									if (text.includes(`"stack":"${stackFilter}"`)) {
										return target.write(chunk);
									}
									return Promise.resolve();
								};
							}
							return Reflect.get(target, prop);
						},
					});
					removeLogClient(writer);
					addLogClient(filteredWriter as WritableStreamDefaultWriter);

					req.signal.addEventListener('abort', () => {
						clearInterval(keepalive);
						removeLogClient(filteredWriter as WritableStreamDefaultWriter);
						writer.close().catch(() => {});
					});
				} else {
					req.signal.addEventListener('abort', () => {
						clearInterval(keepalive);
						removeLogClient(writer);
						writer.close().catch(() => {});
					});
				}

				return new Response(readable, {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					},
				});
			}

			// Stack lock — acquire
			const lockMatch = url.pathname.match(/^\/api\/stacks\/([^/]+)\/lock$/);
			if (lockMatch && req.method === 'POST') {
				const stackName = decodeURIComponent(lockMatch[1] as string);
				const acquired = acquireLock(stackName);
				if (acquired) {
					log('info', `CLI sync lock acquired for "${stackName}"`, stackName);
					return Response.json({ ok: true });
				}
				return Response.json({ error: 'already locked' }, { status: 409 });
			}

			// Stack lock — release
			if (lockMatch && req.method === 'DELETE') {
				const stackName = decodeURIComponent(lockMatch[1] as string);
				releaseLock(stackName);
				log('info', `CLI sync lock released for "${stackName}"`, stackName);
				return Response.json({ ok: true });
			}

			// List active locks
			if (url.pathname === '/api/locks' && req.method === 'GET') {
				return Response.json({ locks: listActiveLocks() });
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
						log('error', `Cache refresh failed for ${fullRepo}: ${err}`);
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

			return new Response('not found', { status: 404 });
		},
	});

	log('info', `Stack daemon listening on port ${cfg.port}`);
	return server;
}

// Auto-start when run directly
if (import.meta.main) {
	// Generate/load daemon token
	daemonToken = ensureDaemonToken();
	log('info', 'Daemon token loaded');

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
		log('error', `Webhook sync failed: ${err}`);
	});

	// Graceful shutdown
	const shutdown = (): void => {
		log('info', 'Shutting down daemon...');
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
