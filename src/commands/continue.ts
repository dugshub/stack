import { Command } from 'clipanion';
import * as git from '../lib/git.js';
import { cascadeDependentStacks, cascadeRebase } from '../lib/rebase.js';
import { findActiveStack, loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class ContinueCommand extends Command {
	static override paths = [['continue']];

	static override usage = Command.Usage({
		description: 'Continue a paused restack after resolving conflicts',
		examples: [
			['Continue after resolving conflicts', 'st continue'],
		],
	});

	async execute(): Promise<number> {
		const originalBranch = git.currentBranch();
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
			await cascadeDependentStacks(state, stackName, true, new Set());
			// Return to the original branch (after dependent cascades which may move HEAD)
			git.checkout(originalBranch);
		}

		return cascadeResult.ok ? 0 : 1;
	}
}
