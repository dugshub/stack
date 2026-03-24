import { isatty } from 'node:tty';
import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { cascadeRebase, rebaseBranch } from '../lib/rebase.js';
import { findActiveStack, findDependentStacks, loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class ModifyCommand extends Command {
	static override paths = [['branch', 'modify'], ['modify']];

	static override usage = Command.Usage({
		description: 'Amend staged changes into the current commit and restack',
		examples: [
			['Amend staged changes and restack', 'st modify'],
			['Stage all changes, amend, and restack', 'st modify -a'],
			['Amend with a new commit message', 'st modify -m "new message"'],
			['Amend without restacking', 'st modify --no-restack'],
		],
	});

	all = Option.Boolean('--all,-a', false, {
		description: 'Stage all changes before amending',
	});

	message = Option.String('--message,-m', {
		description: 'New commit message for the amended commit',
	});

	restack = Option.Boolean('--restack', true, {
		description: 'Restack downstream branches after amending',
	});

	async execute(): Promise<number> {
		const originalBranch = git.currentBranch();

		// Stage all if -a flag
		if (this.all) {
			git.run('add', '-A');
		}

		// Check if anything is staged
		const staged = git.tryRun('diff', '--cached', '--quiet');
		if (staged.ok && !this.message) {
			// Nothing staged and no message change
			ui.error('Nothing to modify. Stage changes first, or use -a to stage all.');
			return 2;
		}

		saveSnapshot('modify');

		// Amend the commit
		const amendArgs = ['commit', '--amend', '--no-edit'];
		if (this.message) {
			// Replace --no-edit with the message
			amendArgs.splice(amendArgs.indexOf('--no-edit'), 1, '-m', this.message);
		}
		const amendResult = git.tryRun(...amendArgs);
		if (!amendResult.ok) {
			ui.error(`Amend failed: ${amendResult.stderr}`);
			return 2;
		}

		ui.success('Amended commit');

		// Find current position in stack
		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		if (!position) {
			// Not in a stack — just amend, no restack needed
			ui.info('Not in a stack — skipping restack.');
			return 0;
		}

		if (!this.restack) {
			ui.info('Skipping restack (--no-restack).');
			return 0;
		}

		if (position.isTop) {
			ui.info('At top of stack — no downstream branches to restack.');
			return 0;
		}

		// Restack downstream branches
		const stack = state.stacks[position.stackName];
		if (!stack) return 0;

		const fromIndex = position.index;

		// Snapshot old tips
		const oldTips: Record<string, string> = {};
		for (let i = fromIndex; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch) continue;
			const tip = branch.tip ?? git.revParse(branch.name);
			oldTips[branch.name] = tip;
		}

		const worktreeMap = git.worktreeList();

		// Stash any remaining uncommitted changes so rebase has a clean worktree
		const dirtyBeforeRebase = git.isDirty();
		if (dirtyBeforeRebase) {
			git.stashPush({ includeUntracked: true, message: 'stack-modify-auto-stash' });
		}

		ui.info('Restacking downstream branches...');
		const cascadeResult = cascadeRebase({
			state,
			stack,
			fromIndex,
			startIndex: fromIndex + 1,
			worktreeMap,
			oldTips,
		});

		if (cascadeResult.ok) {
			// Return to the original branch
			git.checkout(originalBranch);
			// Restore stashed changes
			if (dirtyBeforeRebase) {
				const pop = git.tryRun('stash', 'pop');
				if (!pop.ok) {
					ui.warn('Auto-stash pop failed — your changes are in `git stash`.');
				}
			}
			ui.success(`Restacked ${cascadeResult.rebased} downstream branch(es)`);

			// Cascade into dependent stacks
			await this.cascadeDependentStacks(state, position.stackName, new Set());
		} else {
			// Restore stashed changes even on conflict so they aren't lost
			if (dirtyBeforeRebase) {
				const pop = git.tryRun('stash', 'pop');
				if (!pop.ok) {
					ui.warn('Auto-stash pop failed — your changes are in `git stash`.');
				}
			}
			ui.error('Restack encountered conflicts.');
			ui.info(`Resolve conflicts, then run ${theme.command('st continue')}.`);
			return 1;
		}

		return 0;
	}

	private async cascadeDependentStacks(
		state: ReturnType<typeof loadAndRefreshState>,
		stackName: string,
		visited: Set<string>,
	): Promise<void> {
		visited.add(stackName);
		const dependents = findDependentStacks(state, stackName);
		if (dependents.length === 0) return;

		for (const { name: depName, stack: depStack } of dependents) {
			if (visited.has(depName)) continue;
			if (depStack.restackState != null) continue;

			const depBranch = depStack.dependsOn?.branch ?? depStack.trunk;
			process.stderr.write('\n');
			ui.info(`Stack "${depName}" depends on "${stackName}" (via ${theme.branch(depBranch)})`);

			if (isatty(2)) {
				const confirmed = await p.confirm({
					message: `Restack dependent stack "${depName}"?`,
					initialValue: true,
				});
				if (p.isCancel(confirmed) || !confirmed) continue;
			}

			saveSnapshot('modify');

			const oldTips: Record<string, string> = {};
			for (const branch of depStack.branches) {
				oldTips[branch.name] = branch.tip ?? git.revParse(branch.name);
			}

			const worktreeMap = git.worktreeList();

			if (depStack.branches.length > 0) {
				const firstBranch = depStack.branches[0];
				if (firstBranch) {
					ui.info(`Rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(depStack.trunk)}...`);
					const result = rebaseBranch({
						branch: firstBranch,
						parentRef: depStack.trunk,
						fallbackOldBase: oldTips[firstBranch.name],
						worktreeMap,
					});
					if (result.ok) {
						if (firstBranch.tip) oldTips[firstBranch.name] = firstBranch.tip;
						ui.success(`Rebased ${theme.branch(firstBranch.name)}`);
					} else {
						depStack.restackState = { fromIndex: -1, currentIndex: 0, oldTips };
						saveState(state);
						ui.error(`Conflict rebasing ${theme.branch(firstBranch.name)}`);
						ui.info(`Resolve conflicts, then run ${theme.command('st continue')}.`);
						return;
					}
				}
			}

			const cascadeResult = cascadeRebase({
				state,
				stack: depStack,
				fromIndex: -1,
				startIndex: 1,
				worktreeMap,
				oldTips,
			});

			if (cascadeResult.ok) {
				ui.success(
					`Restacked ${cascadeResult.rebased + (depStack.branches.length > 0 ? 1 : 0)} branches in "${depName}"`,
				);
				await this.cascadeDependentStacks(state, depName, visited);
			}
		}
	}
}
