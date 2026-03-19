import { Command } from 'clipanion';
import * as git from '../lib/git.js';
import { loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class AbortCommand extends Command {
	static override paths = [['abort']];

	static override usage = Command.Usage({
		description: 'Abort an in-progress restack',
		examples: [
			['Abort an in-progress restack', 'stack abort'],
		],
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();

		// Find stack with restackState
		let stackName: string | undefined;
		let stack:
			| NonNullable<ReturnType<typeof loadState>['stacks'][string]>
			| undefined;

		for (const [name, s] of Object.entries(state.stacks)) {
			if (s.restackState) {
				stackName = name;
				stack = s;
				break;
			}
		}

		if (!stackName || !stack || !stack.restackState) {
			ui.error('No restack in progress');
			return 2;
		}

		const restackState = stack.restackState;
		const currentBranch = stack.branches[restackState.currentIndex];

		// Determine execution directory
		const worktreeMap = git.worktreeList();
		const worktreePath = currentBranch
			? worktreeMap.get(currentBranch.name)
			: undefined;

		// Run git rebase --abort
		if (worktreePath) {
			Bun.spawnSync(['git', 'rebase', '--abort'], {
				stdout: 'pipe',
				stderr: 'pipe',
				cwd: worktreePath,
			});
		} else {
			git.tryRun('rebase', '--abort');
		}

		// Clear restackState
		const fromIndex = restackState.fromIndex;
		stack.restackState = null;
		saveState(state);

		ui.success('Restack aborted.');
		ui.info(
			`Branches after position ${fromIndex + 1} are in their pre-restack state.`,
		);
		return 0;
	}
}
