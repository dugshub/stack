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
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { link, theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';
import { findActiveJobForStack } from '../server/state.js';
import { getDaemonPort } from '../server/lifecycle.js';
import type { MergeJob, MergeStep } from '../server/types.js';

export class MergeCommand extends Command {
	static override paths = [['merge']];

	static override usage = Command.Usage({
		description: 'Merge stack PRs bottom-up via webhook-driven orchestration',
		examples: [
			['Merge entire stack', 'stack merge --all'],
			['Show merge plan', 'stack merge --dry-run'],
			['Check active merge status', 'stack merge --status'],
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

	stackOpt = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	async execute(): Promise<number> {
		if (this.status) {
			return this.showStatus();
		}

		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackOpt });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName: resolvedName, stack } = resolved;

		if (this.dryRun) {
			return this.showDryRun(stack, resolvedName);
		}

		if (!this.all) {
			ui.error(
				`Use ${theme.command('stack merge --all')} to merge the entire stack.`,
			);
			return 2;
		}

		return this.startMerge(state, stack, resolvedName);
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

	private async showStatus(): Promise<number> {
		const state = loadAndRefreshState();

		let resolvedName: string;
		try {
			const resolved = await resolveStack({ state, explicitName: this.stackOpt });
			resolvedName = resolved.stackName;
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const activeJob = findActiveJobForStack(resolvedName);
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

		// Filter out already-merged PRs (handles resuming after partial merge)
		const prStatuses = gh.prViewBatch(branchesWithPR.map((b) => b.pr as number));
		const unmergedBranches = branchesWithPR.filter((b) => {
			const status = prStatuses.get(b.pr as number);
			if (status?.state === 'MERGED') {
				ui.success(`#${b.pr} already merged — skipping`);
				return false;
			}
			return true;
		});

		if (unmergedBranches.length === 0) {
			ui.success('All PRs in this stack are already merged.');
			this.cleanupLocal(state, stackName, stack);
			return 0;
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

		// Retarget first unmerged PR to trunk if its base was already merged
		const firstUnmerged = unmergedBranches[0];
		if (firstUnmerged && firstUnmerged !== branchesWithPR[0]) {
			ui.info(`Retargeting #${firstUnmerged.pr} to ${stack.trunk}...`);
			gh.prEdit(firstUnmerged.pr as number, { base: stack.trunk });
		}

		// Build merge job
		const jobId = `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const steps: MergeStep[] = unmergedBranches.map((branch) => ({
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

		// Daemon is auto-started by cli.ts — just get the port
		const port = getDaemonPort();

		// POST job to daemon
		const { loadDaemonToken } = await import('../lib/daemon-client.js');
		const token = loadDaemonToken();
		const jobHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token) jobHeaders.Authorization = `Bearer ${token}`;

		let response: Response;
		try {
			response = await fetch(`http://localhost:${port}/api/jobs`, {
				method: 'POST',
				headers: jobHeaders,
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
		const { loadDaemonToken } = await import('../lib/daemon-client.js');
		const sseToken = loadDaemonToken();
		const sseHeaders: Record<string, string> = {};
		if (sseToken) sseHeaders.Authorization = `Bearer ${sseToken}`;

		while (reconnects < maxReconnects) {
			try {
				const response = await fetch(
					`http://localhost:${port}/api/jobs/${jobId}/events`,
					{ headers: sseHeaders },
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
		const { loadDaemonToken } = await import('../lib/daemon-client.js');
		const sseToken = loadDaemonToken();
		const sseHeaders: Record<string, string> = {};
		if (sseToken) sseHeaders.Authorization = `Bearer ${sseToken}`;

		while (reconnects < maxReconnects) {
			try {
				const response = await fetch(
					`http://localhost:${port}/api/jobs/${jobId}/events`,
					{ headers: sseHeaders },
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
		if (state.currentStack === stackName) {
			state.currentStack = null;
		}
		saveState(state);

		// Checkout trunk
		try {
			git.checkout(stack.trunk);
			git.tryRun('pull', '--ff-only');
		} catch {
			// Non-fatal
		}
	}
}
