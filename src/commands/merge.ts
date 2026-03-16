import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isatty } from 'node:tty';
import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import {
	type MergeDisplay,
	type StepDisplay,
	lineCount,
	renderMergeDisplay,
} from '../lib/merge-display.js';
import { fetchCheckStatus } from '../lib/merge-poller.js';
import { findActiveStack, loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { link, theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';
import { findActiveJobForStack } from '../server/state.js';
import type { MergeJob, MergeStep, ServerConfig } from '../server/types.js';

const DEFAULT_PORT = 7654;

export class MergeCommand extends Command {
	static override paths = [['merge']];

	static override usage = Command.Usage({
		description: 'Merge stack PRs bottom-up via webhook-driven orchestration',
		examples: [
			['Merge entire stack', 'stack merge --all'],
			['Show merge plan', 'stack merge --dry-run'],
			['Check active merge status', 'stack merge --status'],
			['Set up webhook configuration', 'stack merge --setup'],
		],
	});

	all = Option.Boolean('--all', false, {
		description: 'Merge all PRs in the stack bottom-up',
	});

	status = Option.Boolean('--status', false, {
		description: 'Show active merge job status',
	});

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show what would happen without starting a merge',
	});

	setup = Option.Boolean('--setup', false, {
		description: 'Configure webhook secret and server settings',
	});

	async execute(): Promise<number> {
		if (this.setup) {
			return this.runSetup();
		}

		if (this.status) {
			return this.showStatus();
		}

		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		if (!position) {
			ui.error(
				`Not on a stack branch. Use ${theme.command('stack status')} to see tracked stacks.`,
			);
			return 2;
		}

		const stack = state.stacks[position.stackName];
		if (!stack) {
			ui.error(`Stack "${position.stackName}" not found`);
			return 2;
		}

		if (this.dryRun) {
			return this.showDryRun(stack, position.stackName);
		}

		if (!this.all) {
			ui.error(
				`Use ${theme.command('stack merge --all')} to merge the entire stack.`,
			);
			return 2;
		}

		return this.startMerge(state, stack, position.stackName);
	}

	private showDryRun(
		stack: ReturnType<typeof loadState>['stacks'][string] & object,
		stackName: string,
	): number {
		const branchesWithPR = stack.branches.filter((b) => b.pr != null);
		if (branchesWithPR.length === 0) {
			ui.error('No PRs found in this stack. Run stack submit first.');
			return 2;
		}

		const repoUrl = `https://github.com/${gh.repoFullName()}`;
		ui.heading('\n  Merge Plan');
		process.stderr.write(
			`  ${theme.muted(''.padEnd(34, '\u2500'))}\n`,
		);

		for (let i = 0; i < branchesWithPR.length; i++) {
			const branch = branchesWithPR[i];
			if (!branch) continue;
			const prText = link(theme.pr(`#${branch.pr}`), `${repoUrl}/pull/${branch.pr}`);
			const suffix =
				i === 0
					? `squash \u2192 ${stack.trunk}`
					: `squash \u2192 ${stack.trunk} (after #${branchesWithPR[i - 1]?.pr})`;
			process.stderr.write(
				`  ${i + 1}. ${prText}  ${theme.branch(branch.name.split('/').pop() ?? branch.name)}  ${theme.muted(suffix)}\n`,
			);
		}

		process.stderr.write(
			`\nRun ${theme.command('stack merge --all')} to start.\n`,
		);
		return 0;
	}

	private showStatus(): number {
		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		if (!position) {
			ui.error('Not on a stack branch.');
			return 2;
		}

		const activeJob = findActiveJobForStack(position.stackName);
		if (!activeJob) {
			ui.info('No active merge job for this stack.');
			return 0;
		}

		ui.heading(`\n  Merge Job: ${activeJob.id}`);
		ui.info(`  Stack: ${theme.stack(activeJob.stackName)}`);
		ui.info(`  Status: ${activeJob.status}`);
		process.stderr.write('\n');

		for (const step of activeJob.steps) {
			const icon =
				step.status === 'done' || step.status === 'merged'
					? theme.success('\u2713')
					: step.status === 'failed'
						? theme.error('\u2717')
						: step.status === 'auto-merge-enabled'
							? theme.warning('\u23F3')
							: theme.muted('\u25CB');
			process.stderr.write(
				`  ${icon} #${step.prNumber} ${step.branch} \u2014 ${step.status}${step.error ? ` (${step.error})` : ''}\n`,
			);
		}

		process.stderr.write('\n');
		return 0;
	}

	private async startMerge(
		state: ReturnType<typeof loadState>,
		stack: ReturnType<typeof loadState>['stacks'][string] & object,
		stackName: string,
	): Promise<number> {
		// Check for existing active job
		const existing = findActiveJobForStack(stackName);
		if (existing) {
			ui.error(
				`A merge job is already active for this stack. Use ${theme.command('stack merge --status')} to check progress.`,
			);
			return 2;
		}

		// Validate all branches have PRs
		const branchesWithPR = stack.branches.filter((b) => b.pr != null);
		if (branchesWithPR.length === 0) {
			ui.error('No PRs found in this stack. Run stack submit first.');
			return 2;
		}

		const branchesWithoutPR = stack.branches.filter((b) => b.pr == null);
		if (branchesWithoutPR.length > 0) {
			ui.error(
				`Some branches have no PR: ${branchesWithoutPR.map((b) => b.name).join(', ')}. Run stack submit first.`,
			);
			return 2;
		}

		// Check if auto-merge is available
		const settings = gh.repoSettings();
		if (!settings.allowAutoMerge) {
			ui.error('Auto-merge is not enabled on this repository.');
			process.stderr.write('\n');
			ui.info('To enable it:');
			if (settings.visibility === 'private') {
				ui.info('  1. Make the repo public, or upgrade to GitHub Pro');
				ui.info('  2. Enable branch protection on the target branch');
			} else {
				ui.info('  1. Enable branch protection on the target branch:');
				ui.info(`     gh api repos/{owner}/{repo}/branches/${stack.trunk}/protection -X PUT --input - <<< '{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}'`);
			}
			ui.info(`  ${settings.visibility === 'private' ? '3' : '2'}. Enable auto-merge:`);
			ui.info('     gh api repos/{owner}/{repo} -X PATCH -f allow_auto_merge=true');
			return 2;
		}

		// Build merge job
		const jobId = `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const steps: MergeStep[] = branchesWithPR.map((branch) => ({
			prNumber: branch.pr as number,
			branch: branch.name,
			status: 'pending' as const,
			branchTip: branch.tip ?? git.revParse(branch.name),
		}));

		const repo = state.repo || gh.repoFullName();
		const job: MergeJob = {
			id: jobId,
			stackName,
			repo,
			trunk: stack.trunk,
			status: 'running',
			strategy: 'squash',
			steps,
			currentStep: 0,
			created: new Date().toISOString(),
			updated: new Date().toISOString(),
		};

		// Show the plan
		const repoUrl = `https://github.com/${repo}`;
		ui.heading('\n  Merge Plan');
		process.stderr.write(`  ${theme.muted(''.padEnd(34, '\u2500'))}\n`);
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			if (!step) continue;
			const prText = link(theme.pr(`#${step.prNumber}`), `${repoUrl}/pull/${step.prNumber}`);
			const suffix =
				i === 0
					? `squash \u2192 ${stack.trunk}`
					: `squash \u2192 ${stack.trunk} (after #${steps[i - 1]?.prNumber})`;
			process.stderr.write(
				`  ${i + 1}. ${prText}  ${theme.branch(step.branch.split('/').pop() ?? step.branch)}  ${theme.muted(suffix)}\n`,
			);
		}
		process.stderr.write('\n');

		// Confirm before proceeding
		if (process.stderr.isTTY) {
			const confirm = await p.confirm({
				message: `Merge ${steps.length} PRs into ${stack.trunk}?`,
			});
			if (p.isCancel(confirm) || !confirm) {
				ui.info('Merge cancelled.');
				return 0;
			}
			process.stderr.write('\n');
		}

		// Ensure config exists
		const config = this.ensureConfig();

		// Ensure server is running
		const port = config.port;
		const serverRunning = await this.checkHealth(port);
		if (!serverRunning) {
			ui.info('Starting merge server...');
			const started = await this.autoStartServer(port);
			if (!started) {
				ui.error(
					'Could not start merge server. Start it manually or check configuration.',
				);
				return 2;
			}
			ui.success('Merge server started');
		}

		// Ensure tunnel is running
		const tunnelUrl = await this.ensureTunnel(port);
		if (!tunnelUrl) {
			ui.error('Could not establish tunnel. Install cloudflared or set publicUrl in server config.');
			return 2;
		}

		// Ensure webhook exists
		const webhookOk = this.ensureWebhook(repo, tunnelUrl, config.webhookSecret);
		if (!webhookOk) {
			ui.error('Could not create GitHub webhook.');
			return 2;
		}

		// POST job to server
		let response: Response;
		try {
			response = await fetch(`http://localhost:${port}/api/jobs`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(job),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ui.error(`Failed to create merge job: ${msg}`);
			return 2;
		}

		const result = (await response.json()) as {
			job?: MergeJob;
			error?: string;
		};
		if (!response.ok) {
			ui.error(`Server rejected job: ${result.error ?? 'unknown error'}`);
			return 2;
		}

		ui.success(
			`#${steps[0]?.prNumber} \u2014 auto-merge enabled`,
		);
		ui.info(
			`Waiting for CI + merge... (${theme.command('stack merge --status')} to check)`,
		);

		// Connect to SSE for live updates
		return this.streamEvents(port, jobId, state, stackName, stack);
	}

	private async streamEvents(
		port: number,
		jobId: string,
		state: ReturnType<typeof loadState>,
		stackName: string,
		stack: ReturnType<typeof loadState>['stacks'][string] & object,
	): Promise<number> {
		const isTTY = isatty(2);

		// For non-TTY, fall back to simple log-line behavior
		if (!isTTY) {
			return this.streamEventsSimple(port, jobId, state, stackName, stack);
		}

		const repo = state.repo || gh.repoFullName();
		const [owner, repoName] = repo.split('/');
		if (!owner || !repoName) {
			ui.error('Could not determine repo owner/name');
			return 2;
		}

		// Build initial display model from stack branches
		const branchesWithPR = stack.branches.filter((b) => b.pr != null);
		const mergeStart = Date.now();
		const stepStartTimes = new Map<number, number>();

		const display: MergeDisplay = {
			stackName,
			steps: branchesWithPR.map((b) => ({
				prNumber: b.pr as number,
				branchShort: b.name.split('/').pop() ?? b.name,
				state: 'pending' as StepDisplay['state'],
			})),
			totalElapsed: 0,
		};

		// Mark first step as active
		if (display.steps[0]) {
			display.steps[0].state = 'auto-merge-enabled';
			stepStartTimes.set(display.steps[0].prNumber, Date.now());
		}

		let previousLineCount = 0;
		const rerender = (): void => {
			display.totalElapsed = Date.now() - mergeStart;
			// Update elapsed for active steps
			for (const step of display.steps) {
				const startTime = stepStartTimes.get(step.prNumber);
				if (startTime && step.state !== 'pending') {
					step.elapsed = Date.now() - startTime;
				}
			}
			if (previousLineCount > 0) {
				process.stderr.write(`\x1b[${previousLineCount}A\x1b[J`);
			}
			const frame = renderMergeDisplay(display);
			process.stderr.write(`${frame}\n`);
			previousLineCount = lineCount(frame);
		};

		rerender();

		// Poll check status every 5s
		const pollInterval = setInterval(() => {
			const activeStep = display.steps.find(
				(s) =>
					s.state === 'checks-running' ||
					s.state === 'auto-merge-enabled' ||
					s.state === 'merging',
			);
			if (activeStep) {
				activeStep.checks = fetchCheckStatus(
					owner,
					repoName,
					activeStep.prNumber,
				);
				// If checks exist and step is auto-merge-enabled, transition to checks-running
				if (
					activeStep.state === 'auto-merge-enabled' &&
					activeStep.checks.length > 0
				) {
					activeStep.state = 'checks-running';
				}
			}
			rerender();
		}, 5000);

		// SSE loop with auto-reconnect
		let reconnects = 0;
		const maxReconnects = 120; // ~10 minutes of reconnect attempts

		while (reconnects < maxReconnects) {
			try {
				const response = await fetch(
					`http://localhost:${port}/api/jobs/${jobId}/events`,
				);
				if (!response.ok || !response.body) {
					clearInterval(pollInterval);
					ui.error('Failed to connect to event stream');
					return 2;
				}

				reconnects = 0; // reset on successful connect
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						const data = JSON.parse(line.slice(6)) as {
							type: string;
							job?: MergeJob;
							message?: string;
							level?: string;
						};

						if (data.type === 'notify' && data.message) {
							this.updateDisplayFromNotify(
								display,
								data.message,
								data.level,
								stepStartTimes,
							);
							rerender();
						}

						if (data.type === 'error' && data.message) {
							const active = display.steps.find(
								(s) => s.state !== 'merged' && s.state !== 'pending',
							);
							if (active) {
								active.state = 'failed';
								active.error = data.message;
							}
							rerender();
						}

						if (data.type === 'done' && data.job) {
							clearInterval(pollInterval);

							if (data.job.status === 'completed') {
								for (const step of display.steps) {
									if (step.state !== 'merged') {
										step.state = 'merged';
									}
								}
								display.activeMessage = undefined;
								rerender();

								process.stderr.write('\n');
								ui.success(
									`Stack "${stackName}" fully merged (${data.job.steps.length} PRs)`,
								);
								this.cleanupLocal(state, stackName, stack);
								return 0;
							}
							if (data.job.status === 'failed') {
								const failedStep = data.job.steps.find(
									(s) => s.status === 'failed',
								);
								const displayStep = display.steps.find(
									(s) => s.prNumber === failedStep?.prNumber,
								);
								if (displayStep) {
									displayStep.state = 'failed';
									displayStep.error = failedStep?.error;
								}
								rerender();

								if (this.tunnelProc) {
									this.tunnelProc.kill();
									this.tunnelProc = null;
								}
								process.stderr.write('\n');
								ui.error(
									`Merge failed: ${failedStep?.error ?? 'unknown error'}`,
								);
								return 1;
							}
						}
					}
				}

				// Stream ended without a done event — reconnect
				reconnects++;
				await new Promise((r) => setTimeout(r, 2000));
			} catch {
				// Connection error — reconnect
				reconnects++;
				await new Promise((r) => setTimeout(r, 2000));
			}
		}

		clearInterval(pollInterval);
		ui.error('Lost connection to merge server after multiple retries.');
		ui.info(`Use ${theme.command('stack merge --status')} to check progress.`);
		return 1;
	}

	private updateDisplayFromNotify(
		display: MergeDisplay,
		message: string,
		level: string | undefined,
		stepStartTimes: Map<number, number>,
	): void {
		// Detect "merged" messages: "#18 merged" or similar
		const mergedMatch = message.match(/#(\d+)\s+.*merged/i);
		if (mergedMatch) {
			const prNum = Number(mergedMatch[1]);
			const step = display.steps.find((s) => s.prNumber === prNum);
			if (step) {
				step.state = 'merged';
			}
		}

		// Detect rebase messages: "Rebasing #19" or similar
		const rebaseMatch = message.match(/[Rr]ebas(?:ing|e)\s+#(\d+)/);
		if (rebaseMatch) {
			const prNum = Number(rebaseMatch[1]);
			const step = display.steps.find((s) => s.prNumber === prNum);
			if (step) {
				step.state = 'rebasing';
				if (!stepStartTimes.has(prNum)) {
					stepStartTimes.set(prNum, Date.now());
				}
			}
			display.activeMessage = message;
			return;
		}

		// Detect auto-merge enabled: "auto-merge enabled" with PR number
		const autoMergeMatch = message.match(/#(\d+)\s+.*auto-merge\s+enabled/i);
		if (autoMergeMatch) {
			const prNum = Number(autoMergeMatch[1]);
			const step = display.steps.find((s) => s.prNumber === prNum);
			if (step && step.state !== 'merged') {
				step.state = 'auto-merge-enabled';
				if (!stepStartTimes.has(prNum)) {
					stepStartTimes.set(prNum, Date.now());
				}
			}
			display.activeMessage = undefined;
			return;
		}

		// Clear active message when transitioning away from rebase
		if (level === 'success') {
			display.activeMessage = undefined;
		}
	}

	private async streamEventsSimple(
		port: number,
		jobId: string,
		state: ReturnType<typeof loadState>,
		stackName: string,
		stack: ReturnType<typeof loadState>['stacks'][string] & object,
	): Promise<number> {
		let reconnects = 0;
		const maxReconnects = 120;

		while (reconnects < maxReconnects) {
			try {
				const response = await fetch(
					`http://localhost:${port}/api/jobs/${jobId}/events`,
				);
				if (!response.ok || !response.body) {
					ui.error('Failed to connect to event stream');
					return 2;
				}

				reconnects = 0;
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						const data = JSON.parse(line.slice(6)) as {
							type: string;
							job?: MergeJob;
							message?: string;
							level?: string;
						};

						if (data.type === 'notify' && data.message) {
							if (data.level === 'success') {
								ui.success(data.message);
							} else if (data.level === 'error') {
								ui.error(data.message);
							} else {
								ui.info(data.message);
							}
						}

						if (data.type === 'error' && data.message) {
							ui.error(data.message);
						}

						if (data.type === 'done' && data.job) {
							if (data.job.status === 'completed') {
								process.stderr.write('\n');
								ui.success(
									`Stack "${stackName}" fully merged (${data.job.steps.length} PRs)`,
								);
								this.cleanupLocal(state, stackName, stack);
								return 0;
							}
							if (data.job.status === 'failed') {
								if (this.tunnelProc) {
									this.tunnelProc.kill();
									this.tunnelProc = null;
								}
								const failedStep = data.job.steps.find(
									(s) => s.status === 'failed',
								);
								ui.error(
									`Merge failed: ${failedStep?.error ?? 'unknown error'}`,
								);
								return 1;
							}
						}
					}
				}

				reconnects++;
				await new Promise((r) => setTimeout(r, 2000));
			} catch {
				reconnects++;
				await new Promise((r) => setTimeout(r, 2000));
			}
		}

		ui.error('Lost connection to merge server after multiple retries.');
		ui.info(`Use ${theme.command('stack merge --status')} to check progress.`);
		return 1;
	}

	private cleanupLocal(
		state: ReturnType<typeof loadState>,
		stackName: string,
		stack: ReturnType<typeof loadState>['stacks'][string] & object,
	): void {
		// Kill tunnel if we started one
		if (this.tunnelProc) {
			this.tunnelProc.kill();
			this.tunnelProc = null;
		}

		// Delete local branches
		let deletedCount = 0;
		for (const branch of stack.branches) {
			const result = git.tryRun('branch', '-d', branch.name);
			if (result.ok) {
				deletedCount++;
			}
		}

		if (deletedCount > 0) {
			ui.success(`Deleted ${deletedCount} local branches`);
		}

		// Remove stack from state
		delete state.stacks[stackName];
		saveState(state);

		// Checkout trunk
		try {
			git.checkout(stack.trunk);
			git.tryRun('pull', '--ff-only');
		} catch {
			// Non-fatal
		}
	}

	private ensureConfig(): ServerConfig {
		const configPath = join(homedir(), '.claude', 'stacks', 'server.config.json');
		let config: ServerConfig;

		if (existsSync(configPath)) {
			try {
				config = JSON.parse(readFileSync(configPath, 'utf-8')) as ServerConfig;
				if (config.webhookSecret && config.port) return config;
			} catch {
				// Regenerate
			}
		}

		const secret = `whsec_${crypto.randomUUID().replace(/-/g, '')}`;
		config = { port: DEFAULT_PORT, webhookSecret: secret };
		mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
		ui.success(`Generated webhook secret`);
		return config;
	}

	private tunnelProc: ReturnType<typeof Bun.spawn> | null = null;

	private async ensureTunnel(port: number): Promise<string | null> {
		// Check if publicUrl is already configured (user-managed tunnel)
		const configPath = join(homedir(), '.claude', 'stacks', 'server.config.json');
		try {
			const config = JSON.parse(readFileSync(configPath, 'utf-8')) as ServerConfig;
			if (config.publicUrl) {
				ui.info(`Using configured tunnel: ${config.publicUrl}`);
				return config.publicUrl;
			}
		} catch {
			// Continue to auto-launch
		}

		// Check if cloudflared is available
		const which = Bun.spawnSync(['which', 'cloudflared'], { stdout: 'pipe', stderr: 'pipe' });
		if (which.exitCode !== 0) {
			ui.error('cloudflared not found.');
			ui.info('Install it:');
			ui.info('  brew install cloudflared');
			ui.info('Or set publicUrl in ~/.claude/stacks/server.config.json for a custom tunnel.');
			return null;
		}

		ui.info('Starting cloudflare tunnel...');
		const proc = Bun.spawn(['cloudflared', 'tunnel', '--url', `http://localhost:${port}`], {
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
		});
		this.tunnelProc = proc;

		// Parse URL from stderr (cloudflared outputs there)
		const tunnelUrl = await new Promise<string | null>((resolve) => {
			const timeout = setTimeout(() => resolve(null), 30000);
			const reader = proc.stderr.getReader();
			let buffer = '';

			const read = (): void => {
				reader.read().then(({ done, value }) => {
					if (done) {
						clearTimeout(timeout);
						resolve(null);
						return;
					}
					buffer += new TextDecoder().decode(value);
					const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
					if (match) {
						clearTimeout(timeout);
						resolve(match[0]);
						return;
					}
					read();
				});
			};
			read();
		});

		if (tunnelUrl) {
			ui.success(`Tunnel: ${tunnelUrl}`);
		}

		return tunnelUrl;
	}

	private ensureWebhook(repo: string, tunnelUrl: string, secret: string): boolean {
		const webhookUrl = `${tunnelUrl}/webhooks/github`;
		const [owner, name] = repo.split('/');
		if (!owner || !name) return false;

		// Check for existing webhook pointing to trycloudflare.com
		const listResult = Bun.spawnSync([
			'gh', 'api', `repos/${owner}/${name}/hooks`,
			'--jq', '.[] | select(.config.url | test("trycloudflare\\\\.com")) | .id',
		], { stdout: 'pipe', stderr: 'pipe' });

		const existingIds = listResult.stdout.toString().trim().split('\n').filter(Boolean);

		// Delete old tunnel webhooks (they have ephemeral URLs)
		for (const id of existingIds) {
			Bun.spawnSync([
				'gh', 'api', `repos/${owner}/${name}/hooks/${id}`, '-X', 'DELETE',
			], { stdout: 'pipe', stderr: 'pipe' });
		}

		// Create new webhook via JSON input (GitHub API requires nested config object)
		const payload = JSON.stringify({
			config: { url: webhookUrl, content_type: 'json', secret },
			events: ['pull_request', 'push'],
			active: true,
		});
		const createResult = Bun.spawnSync([
			'gh', 'api', `repos/${owner}/${name}/hooks`,
			'-X', 'POST', '--input', '-', '--jq', '.id',
		], { stdout: 'pipe', stderr: 'pipe', stdin: Buffer.from(payload) });

		if (createResult.exitCode !== 0) {
			const stderr = createResult.stderr.toString();
			ui.error(`Webhook creation failed: ${stderr}`);
			return false;
		}

		const hookId = createResult.stdout.toString().trim();
		ui.success(`Webhook created (id: ${hookId})`);
		return true;
	}

	private getServerPort(): number {
		const configPath = join(
			homedir(),
			'.claude',
			'stacks',
			'server.config.json',
		);
		try {
			const text = readFileSync(configPath, 'utf-8');
			const config = JSON.parse(text) as ServerConfig;
			return config.port || DEFAULT_PORT;
		} catch {
			return DEFAULT_PORT;
		}
	}

	private async checkHealth(port: number): Promise<boolean> {
		try {
			const response = await fetch(`http://localhost:${port}/health`);
			return response.ok;
		} catch {
			return false;
		}
	}

	private async autoStartServer(port: number): Promise<boolean> {
		const pidPath = join(homedir(), '.claude', 'stacks', 'server.pid');
		const cliPath = join(import.meta.dir, '..', 'server', 'index.ts');

		const proc = Bun.spawn(['bun', 'run', cliPath], {
			stdout: 'ignore',
			stderr: 'ignore',
			stdin: 'ignore',
		});
		proc.unref();

		// Write PID
		try {
			writeFileSync(pidPath, String(proc.pid), 'utf-8');
		} catch {
			// Non-fatal
		}

		// Wait up to 5s for health check
		for (let i = 0; i < 10; i++) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			const healthy = await this.checkHealth(port);
			if (healthy) return true;
		}

		return false;
	}

	private runSetup(): number {
		const configPath = join(
			homedir(),
			'.claude',
			'stacks',
			'server.config.json',
		);

		// Generate webhook secret
		const secret = `whsec_${crypto.randomUUID().replace(/-/g, '')}`;
		const config: ServerConfig = {
			port: DEFAULT_PORT,
			webhookSecret: secret,
		};

		// Load existing config if present
		if (existsSync(configPath)) {
			try {
				const text = readFileSync(configPath, 'utf-8');
				const existing = JSON.parse(text) as ServerConfig;
				config.port = existing.port || DEFAULT_PORT;
				config.publicUrl = existing.publicUrl;
			} catch {
				// Use defaults
			}
		}

		// Write config
		mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
		writeFileSync(
			configPath,
			`${JSON.stringify(config, null, 2)}\n`,
			'utf-8',
		);

		ui.success('Webhook configuration saved');
		ui.info(`  Secret: ${secret}`);
		ui.info(`  Port: ${config.port}`);
		process.stderr.write('\n');
		ui.info('Next steps:');
		ui.info(
			`  1. Set up a tunnel (e.g. ngrok) to expose port ${config.port}`,
		);
		ui.info('  2. Create a GitHub webhook:');
		ui.info(`     URL: <your-tunnel-url>/webhooks/github`);
		ui.info(`     Secret: ${secret}`);
		ui.info('     Events: Pull requests');
		process.stderr.write('\n');
		ui.info(
			`Or create the webhook via gh CLI:\n  gh api repos/{owner}/{repo}/hooks -f url="<tunnel-url>/webhooks/github" -f content_type=json -f secret="${secret}" -f 'events[]=pull_request'`,
		);

		return 0;
	}
}
