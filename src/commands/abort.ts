import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'clipanion';
import * as git from '../lib/git.js';
import { loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import * as ui from '../lib/ui.js';

export class AbortCommand extends Command {
	static override paths = [['abort']];

	static override usage = Command.Usage({
		description: 'Abort an in-progress restack',
		examples: [
			['Abort an in-progress restack', 'st abort'],
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

		if (restackState.joinState) {
			const js = restackState.joinState;
			const gitDirResult = git.tryRun('rev-parse', '--git-dir');
			const gitDir = gitDirResult.ok ? gitDirResult.stdout : '.git';
			if (existsSync(join(gitDir, 'MERGE_HEAD'))) {
				git.tryRun('merge', '--abort');
			}
			if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) {
				git.tryRun('cherry-pick', '--abort');
			}
			git.tryRun('checkout', js.branchName);
			git.tryRun('reset', '--hard', js.oldJoinTip);
		} else if (worktreePath) {
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
