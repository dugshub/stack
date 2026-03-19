import { isatty } from 'node:tty';
import * as p from '@clack/prompts';
import { Command } from 'clipanion';
import * as git from '../lib/git.js';
import { cascadeRebase, rebaseBranch } from '../lib/rebase.js';
import { findActiveStack, findDependentStacks, loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { StackFile } from '../lib/types.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class ContinueCommand extends Command {
	static override paths = [['continue']];

	static override usage = Command.Usage({
		description: 'Continue a paused restack after resolving conflicts',
		examples: [
			['Continue after resolving conflicts', 'stack continue'],
		],
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		// Find stack with restackState -- may not be on a stack branch if in conflict
		let stackName: string | undefined;
		let stack:
			| NonNullable<ReturnType<typeof loadState>['stacks'][string]>
			| undefined;

		if (position) {
			stackName = position.stackName;
			stack = state.stacks[stackName];
		} else {
			// Search for a stack with restackState
			for (const [name, s] of Object.entries(state.stacks)) {
				if (s.restackState) {
					stackName = name;
					stack = s;
					break;
				}
			}
		}

		if (!stackName || !stack) {
			ui.error('No stack found with an in-progress restack');
			return 2;
		}

		if (!stack.restackState) {
			ui.error('No restack in progress');
			return 2;
		}

		const restackState = stack.restackState;
		const currentBranch = stack.branches[restackState.currentIndex];
		if (!currentBranch) {
			ui.error('Could not determine current restack branch');
			return 2;
		}

		// Determine execution directory
		const worktreeMap = git.worktreeList();
		const worktreePath = worktreeMap.get(currentBranch.name);

		// Run git rebase --continue
		let continueResult: { ok: boolean; exitCode: number };
		if (worktreePath) {
			const result = Bun.spawnSync(['git', 'rebase', '--continue'], {
				stdout: 'pipe',
				stderr: 'pipe',
				cwd: worktreePath,
				env: { ...process.env, GIT_EDITOR: 'true' },
			});
			continueResult = { ok: result.exitCode === 0, exitCode: result.exitCode };
		} else {
			const result = git.tryRun('rebase', '--continue');
			continueResult = { ok: result.ok, exitCode: result.exitCode };
		}

		if (!continueResult.ok) {
			// Check if a rebase is actually in progress -- if not, it was already
			// completed externally (e.g. user ran `git rebase --continue` directly)
			if (git.isRebaseInProgress(worktreePath ?? undefined)) {
				ui.error(
					'Rebase continue failed. There may still be unresolved conflicts.',
				);
				return 1;
			}

			// No rebase in progress -- it was completed outside of stack
			ui.info('Rebase already completed externally, updating stack state...');
		}

		// Update tip and parentTip -- use worktree cwd if branch is in a worktree
		currentBranch.tip = git.revParse(currentBranch.name, {
			cwd: worktreePath ?? undefined,
		});
		// Parent ref: previous branch, or trunk if first branch
		const parentBranch = stack.branches[restackState.currentIndex - 1];
		currentBranch.parentTip = parentBranch
			? git.revParse(parentBranch.name)
			: git.revParse(stack.trunk);
		restackState.oldTips[currentBranch.name] = currentBranch.tip;
		restackState.currentIndex += 1;
		saveState(state);
		ui.success(`Rebased ${theme.branch(currentBranch.name)}`);

		// Continue cascade
		const cascadeResult = cascadeRebase({
			state,
			stack,
			fromIndex: restackState.fromIndex,
			startIndex: restackState.currentIndex,
			worktreeMap,
			oldTips: restackState.oldTips,
		});

		if (cascadeResult.ok) {
			ui.success(
				`Restacked remaining branches in "${stackName}"`,
			);
			await this.cascadeDependentStacks(state, stackName, true, new Set());
		}

		return cascadeResult.ok ? 0 : 1;
	}

	private async cascadeDependentStacks(
		state: StackFile,
		stackName: string,
		cascade: boolean,
		visited: Set<string>,
	): Promise<void> {
		visited.add(stackName);
		const dependents = findDependentStacks(state, stackName);
		if (dependents.length === 0) return;

		for (const { name: depName, stack: depStack } of dependents) {
			if (visited.has(depName)) {
				ui.warn(`Circular dependency detected: "${depName}" already visited, skipping.`);
				continue;
			}

			if (depStack.restackState != null) {
				ui.warn(`Restack already in progress on "${depName}", skipping.`);
				continue;
			}

			const depBranch = depStack.dependsOn?.branch ?? depStack.trunk;
			process.stderr.write('\n');
			ui.info(`Stack "${depName}" depends on "${stackName}" (via ${theme.branch(depBranch)})`);

			if (!cascade) {
				ui.info(`Tip: Run ${theme.command(`stack restack -s ${depName}`)} to update it.`);
				continue;
			}

			if (isatty(2)) {
				const confirmed = await p.confirm({
					message: `Restack dependent stack "${depName}"?`,
					initialValue: true,
				});
				if (p.isCancel(confirmed) || !confirmed) {
					continue;
				}
			}

			saveSnapshot('restack');

			const oldTips: Record<string, string> = {};
			for (const branch of depStack.branches) {
				const tip = branch.tip ?? git.revParse(branch.name);
				oldTips[branch.name] = tip;
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
						ui.error(`Conflict rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(depStack.trunk)}`);
						if (result.conflicts.length > 0) {
							ui.info('Conflicting files:');
							for (const file of result.conflicts) {
								ui.info(`  ${file}`);
							}
						}
						ui.info(`Resolve conflicts, stage files, then run ${theme.command('stack continue')}.`);
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
				await this.cascadeDependentStacks(state, depName, cascade, visited);
			} else {
				return;
			}
		}
	}
}
