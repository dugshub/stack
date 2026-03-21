import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { findActiveStack, loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { link, theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';
import { getDaemonPort, isDaemonHealthy } from '../server/lifecycle.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MergeCommand extends Command {
	static override paths = [['stack', 'merge'], ['merge']];

	static override usage = Command.Usage({
		description: 'Merge stack PRs via auto-merge',
		examples: [
			['Enable auto-merge on current branch', 'st merge'],
			['Merge entire stack', 'st merge --all'],
			['Merge current branch immediately', 'st merge --now'],
			['Show merge plan', 'st merge --dry-run'],
		],
	});

	all = Option.Boolean('--all', false, {
		description: 'Merge all PRs in the stack bottom-up',
	});

	now = Option.Boolean('--now', false, {
		description: 'Merge current branch immediately (must be targeted at trunk)',
	});

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show what would happen without starting a merge',
	});

	stackOpt = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	async execute(): Promise<number> {
		if (this.dryRun) return this.showDryRun();
		if (this.now) return this.mergeNow();
		if (this.all) return this.mergeAll();
		return this.mergeCurrent();
	}

	/** st merge — enable auto-merge on current branch's PR */
	private async mergeCurrent(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stack, position } = resolved;
		if (!position) {
			ui.error('Not on a stack branch');
			return 2;
		}

		const branch = stack.branches[position.index];
		if (!branch?.pr) {
			ui.error('No PR for current branch. Run st submit first.');
			return 2;
		}

		const result = gh.prMergeAuto(branch.pr, { strategy: 'squash' });
		if (!result.ok) {
			ui.error(`Failed to enable auto-merge: ${result.error}`);
			return 2;
		}
		ui.success(`Auto-merge enabled on #${branch.pr}`);
		return 0;
	}

	/** st merge --now — merge immediately (PR must be targeted at trunk) */
	private async mergeNow(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stack, position } = resolved;
		if (!position) {
			ui.error('Not on a stack branch');
			return 2;
		}

		const branch = stack.branches[position.index];
		if (!branch?.pr) {
			ui.error('No PR for current branch.');
			return 2;
		}

		// Warn if not targeted at trunk (i.e., not the bottom PR)
		if (position.index > 0) {
			ui.warn(`PR #${branch.pr} is not the bottom of the stack. It may fail if targeted at a branch PR.`);
		}

		const mergeProc = Bun.spawnSync(['gh', 'pr', 'merge', String(branch.pr), '--squash'], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if (mergeProc.exitCode !== 0) {
			ui.error(`Merge failed: ${mergeProc.stderr.toString().trim()}`);
			return 2;
		}
		ui.success(`Merged #${branch.pr}`);
		return 0;
	}

	/** st merge --all — merge entire stack */
	private async mergeAll(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackOpt });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName, stack } = resolved;

		// Validate all branches have PRs
		const branchesWithPR = stack.branches.filter((b) => b.pr != null);
		if (branchesWithPR.length === 0) {
			ui.error('No PRs found. Run st submit first.');
			return 2;
		}

		const branchesWithoutPR = stack.branches.filter((b) => b.pr == null);
		if (branchesWithoutPR.length > 0) {
			ui.error(
				`Branches without PRs: ${branchesWithoutPR.map((b) => b.name).join(', ')}. Run st submit.`,
			);
			return 2;
		}

		// Filter out already-merged PRs
		const prStatuses = gh.prViewBatch(branchesWithPR.map((b) => b.pr as number));
		const unmerged = branchesWithPR.filter((b) => {
			const s = prStatuses.get(b.pr as number);
			if (s?.state === 'MERGED') {
				ui.success(`#${b.pr} already merged`);
				return false;
			}
			return true;
		});

		if (unmerged.length === 0) {
			ui.success('All PRs already merged.');
			this.cleanupLocal(state, stackName, stack);
			return 0;
		}

		// Check for draft PRs
		const draftBranches = unmerged.filter((b) => {
			const status = prStatuses.get(b.pr as number);
			return status?.isDraft;
		});

		if (draftBranches.length > 0) {
			const draftList = draftBranches.map((b) => `#${b.pr}`).join(', ');
			ui.warn(`Draft PRs found: ${draftList}`);

			if (process.stderr.isTTY) {
				const ready = await p.confirm({
					message: `Mark ${draftBranches.length} draft PR${draftBranches.length > 1 ? 's' : ''} as ready for review?`,
				});
				if (p.isCancel(ready) || !ready) {
					ui.info('Merge cancelled. Mark PRs as ready first.');
					return 2;
				}
				for (const b of draftBranches) {
					gh.prReady(b.pr as number);
					ui.success(`Marked #${b.pr} as ready for review`);
				}
			} else {
				ui.error('Cannot merge draft PRs. Mark them as ready first.');
				return 2;
			}
		}

		// Show plan + confirm
		this.showMergePlan(unmerged, stack.trunk, state.repo);
		if (process.stderr.isTTY) {
			const confirm = await p.confirm({ message: `Merge ${unmerged.length} PRs?` });
			if (p.isCancel(confirm) || !confirm) return 0;
		}

		// Check auto-merge availability
		const settings = gh.repoSettings();
		if (!settings.allowAutoMerge) {
			ui.error('Auto-merge is not enabled on this repository.');
			ui.info('Enable it: gh api repos/{owner}/{repo} -X PATCH -f allow_auto_merge=true');
			return 2;
		}

		// Retarget first unmerged PR to trunk if its base was already merged
		const first = unmerged[0]!;
		const firstOrigIndex = stack.branches.indexOf(first);
		if (firstOrigIndex > 0) {
			ui.info(`Retargeting #${first.pr} to ${stack.trunk}...`);
			gh.prEdit(first.pr as number, { base: stack.trunk });
		}

		// Enable auto-merge on first unmerged PR
		const mergeResult = gh.prMergeAuto(first.pr as number, { strategy: 'squash' });
		if (!mergeResult.ok) {
			ui.error(`Failed to enable auto-merge on #${first.pr}: ${mergeResult.error}`);
			return 2;
		}
		ui.success(`Auto-merge enabled on #${first.pr}`);

		// If daemon is running: attach to log stream and watch
		if (await isDaemonHealthy()) {
			ui.info('Daemon is running — watching merge cascade...');
			return this.streamDaemonLogs(stackName, state, stack);
		}

		// Fallback: local poll loop
		ui.info('No daemon — running merge loop locally...');
		return this.mergeLocal(stackName, state, stack, unmerged);
	}

	private async streamDaemonLogs(
		stackName: string,
		state: ReturnType<typeof loadState>,
		stack: ReturnType<typeof loadState>['stacks'][string] & object,
	): Promise<number> {
		const port = getDaemonPort();
		const { loadDaemonToken } = await import('../lib/daemon.js');
		const token = loadDaemonToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;

		const url = `http://localhost:${port}/api/logs?stack=${encodeURIComponent(stackName)}`;

		try {
			const response = await fetch(url, { headers });
			if (!response.ok || !response.body) {
				ui.warn('Could not attach to daemon logs. The cascade will run in the background.');
				ui.info(`Use ${theme.command('st daemon attach --stack ' + stackName)} to monitor.`);
				return 0;
			}

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
					try {
						const entry = JSON.parse(line.slice(6)) as {
							level: string;
							message: string;
							stack?: string;
						};

						// Display the log line
						if (entry.level === 'success') {
							ui.success(entry.message);
						} else if (entry.level === 'error') {
							ui.error(entry.message);
						} else {
							ui.info(entry.message);
						}

						// Detect completion
						if (entry.message.includes('fully merged')) {
							this.cleanupLocal(state, stackName, stack);
							return 0;
						}

						// Detect stall
						if (entry.message.includes('cascade stalled')) {
							return 1;
						}
					} catch {
						// Skip malformed
					}
				}
			}
		} catch {
			ui.warn('Lost connection to daemon. The cascade continues in the background.');
			ui.info(`Use ${theme.command('st daemon attach --stack ' + stackName)} to monitor.`);
		}

		return 0;
	}

	private async mergeLocal(
		stackName: string,
		state: ReturnType<typeof loadState>,
		stack: ReturnType<typeof loadState>['stacks'][string] & object,
		unmerged: Array<{ name: string; pr: number | null; tip: string | null }>,
	): Promise<number> {
		// Acquire CLI sync lock (prevents daemon from competing)
		await this.acquireLock(stackName);

		try {
			// First PR already has auto-merge enabled (done in mergeAll)
			for (let i = 0; i < unmerged.length; i++) {
				const branch = unmerged[i]!;

				// Poll until merged
				ui.info(`Waiting for #${branch.pr} to merge...`);
				while (true) {
					await sleep(15_000);
					const status = gh.prView(branch.pr as number);
					if (status?.state === 'MERGED') break;
					if (status?.state === 'CLOSED') {
						ui.error(`#${branch.pr} was closed without merging.`);
						return 1;
					}
				}
				ui.success(`#${branch.pr} merged`);

				// If there's a next PR, sync + enable auto-merge
				const next = unmerged[i + 1];
				if (next) {
					git.fetch();

					// Update trunk
					try {
						git.run('checkout', stack.trunk);
						git.tryRun('merge', '--ff-only', `origin/${stack.trunk}`);
					} catch {
						// Non-fatal
					}

					// Rebase next branch onto trunk
					const oldBase = branch.tip ?? git.revParse(branch.name);
					git.run('checkout', next.name);
					const rebaseResult = git.tryRun(
						'rebase', '--onto', stack.trunk, '--empty=drop', oldBase, next.name,
					);
					if (!rebaseResult.ok) {
						git.tryRun('rebase', '--abort');
						ui.error(`Rebase failed for ${next.name}. Run st sync to fix.`);
						return 1;
					}

					// Push
					git.pushForceWithLease('origin', next.name);

					// Retarget + enable auto-merge on next
					gh.prEdit(next.pr as number, { base: stack.trunk });
					const autoResult = gh.prMergeAuto(next.pr as number, { strategy: 'squash' });
					if (autoResult.ok) {
						ui.success(`Auto-merge enabled on #${next.pr}`);
					} else {
						ui.error(`Failed to enable auto-merge on #${next.pr}: ${autoResult.error}`);
						return 1;
					}
				}
			}
		} finally {
			await this.releaseLock(stackName);
		}

		// Cleanup
		this.cleanupLocal(state, stackName, stack);
		return 0;
	}

	private async acquireLock(stackName: string): Promise<void> {
		try {
			const port = getDaemonPort();
			const { loadDaemonToken } = await import('../lib/daemon.js');
			const token = loadDaemonToken();
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (token) headers.Authorization = `Bearer ${token}`;
			await fetch(`http://localhost:${port}/api/stacks/${encodeURIComponent(stackName)}/lock`, {
				method: 'POST',
				headers,
				signal: AbortSignal.timeout(2000),
			}).catch(() => {});
		} catch {
			// Non-fatal — daemon might not be running
		}
	}

	private async releaseLock(stackName: string): Promise<void> {
		try {
			const port = getDaemonPort();
			const { loadDaemonToken } = await import('../lib/daemon.js');
			const token = loadDaemonToken();
			const headers: Record<string, string> = {};
			if (token) headers.Authorization = `Bearer ${token}`;
			await fetch(`http://localhost:${port}/api/stacks/${encodeURIComponent(stackName)}/lock`, {
				method: 'DELETE',
				headers,
				signal: AbortSignal.timeout(2000),
			}).catch(() => {});
		} catch {
			// Non-fatal
		}
	}

	private showDryRun(): number {
		const state = loadAndRefreshState();

		let stackName: string;
		let stack: ReturnType<typeof loadState>['stacks'][string] & object;
		try {
			// resolveStack is async but we only need the sync path
			const currentBranch = git.currentBranch();
			const active = findActiveStack(state);
			if (!active) {
				if (this.stackOpt && state.stacks[this.stackOpt]) {
					stackName = this.stackOpt;
					stack = state.stacks[this.stackOpt]!;
				} else {
					ui.error('Not on a stack branch.');
					return 2;
				}
			} else {
				stackName = this.stackOpt ?? active.stackName;
				const s = state.stacks[stackName];
				if (!s) {
					ui.error(`Stack "${stackName}" not found.`);
					return 2;
				}
				stack = s;
			}
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const branchesWithPR = stack.branches.filter((b) => b.pr != null);
		if (branchesWithPR.length === 0) {
			ui.error('No PRs found in this stack. Run stack submit first.');
			return 2;
		}

		const repo = state.repo || gh.repoFullName();
		const repoUrl = `https://github.com/${repo}`;
		ui.heading('\n  Merge Plan');
		process.stderr.write(`  ${theme.muted(''.padEnd(34, '\u2500'))}\n`);

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
			`\nRun ${theme.command('st merge --all')} to start.\n`,
		);
		return 0;
	}

	private showMergePlan(
		branches: Array<{ name: string; pr: number | null }>,
		trunk: string,
		repo?: string,
	): void {
		const repoName = repo || gh.repoFullName();
		const repoUrl = `https://github.com/${repoName}`;
		ui.heading('\n  Merge Plan');
		process.stderr.write(`  ${theme.muted(''.padEnd(34, '\u2500'))}\n`);

		for (let i = 0; i < branches.length; i++) {
			const branch = branches[i];
			if (!branch) continue;
			const prText = link(theme.pr(`#${branch.pr}`), `${repoUrl}/pull/${branch.pr}`);
			const suffix =
				i === 0
					? `squash \u2192 ${trunk}`
					: `squash \u2192 ${trunk} (after #${branches[i - 1]?.pr})`;
			process.stderr.write(
				`  ${i + 1}. ${prText}  ${theme.branch(branch.name.split('/').pop() ?? branch.name)}  ${theme.muted(suffix)}\n`,
			);
		}
		process.stderr.write('\n');
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

		ui.success(`Stack "${stackName}" cleaned up`);
	}
}
