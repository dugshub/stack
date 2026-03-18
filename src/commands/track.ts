import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { findActiveStack, loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class TrackCommand extends Command {
	static override paths = [['track']];

	static override usage = Command.Usage({
		description: 'Add the current branch to a stack',
		examples: [
			['Track current branch in active stack', 'stack track'],
			['Track in a specific stack', 'stack track --stack frozen-column'],
		],
	});

	stack = Option.String('--stack,-s', {
		description: 'Stack name (if not on a stack branch)',
	});

	async execute(): Promise<number> {
		const currentBranch = git.currentBranch();
		const state = loadAndRefreshState();

		// Find the stack to track in
		let stackName: string | undefined;

		if (this.stack) {
			stackName = this.stack;
			if (!state.stacks[stackName]) {
				ui.error(`Stack "${stackName}" not found`);
				return 2;
			}
		} else {
			// Try to find active stack from current branch
			const position = findActiveStack(state);
			if (position) {
				ui.error(
					`Branch "${currentBranch}" is already in stack "${position.stackName}" at position ${position.index + 1}.`,
				);
				return 2;
			}

			// Check if there is exactly one stack — use it
			const stackNames = Object.keys(state.stacks);
			if (stackNames.length === 0) {
				ui.error(`No tracked stacks. Use ${theme.command('stack create <name>')} to start one.`);
				return 2;
			}
			if (stackNames.length === 1) {
				stackName = stackNames[0];
			} else {
				ui.error(
					'Multiple stacks exist. Use --stack <name> to specify which one.',
				);
				return 2;
			}
		}

		if (!stackName) {
			ui.error('Could not determine stack');
			return 2;
		}

		const stack = state.stacks[stackName];
		if (!stack) {
			ui.error(`Stack "${stackName}" not found`);
			return 2;
		}

		// Check current branch is not already in stack
		for (const branch of stack.branches) {
			if (branch.name === currentBranch) {
				ui.error(
					`Branch "${currentBranch}" is already in stack "${stackName}"`,
				);
				return 2;
			}
		}

		// Verify ancestry — current branch must descend from stack's top branch
		const topBranch = stack.branches[stack.branches.length - 1];
		if (topBranch) {
			if (!git.isAncestor(topBranch.name, currentBranch)) {
				ui.error(
					`Current branch "${currentBranch}" does not descend from stack top "${topBranch.name}". ` +
						'Ensure your branch is based on the top of the stack.',
				);
				return 2;
			}
		}

		saveSnapshot('track');

		const tip = git.revParse('HEAD');
		const parentBranch = stack.branches[stack.branches.length - 1];
		const parentTip = parentBranch
			? parentBranch.tip ?? git.revParse(parentBranch.name)
			: git.revParse(stack.trunk);
		stack.branches.push({ name: currentBranch, tip, pr: null, parentTip });
		stack.updated = new Date().toISOString();
		saveState(state);

		const newIndex = stack.branches.length - 1;
		ui.success(
			`Added ${theme.branch(currentBranch)} to stack ${theme.stack(stackName)} at position ${newIndex + 1}`,
		);
		ui.positionReport({
			stackName,
			index: newIndex,
			total: stack.branches.length,
			branch: { name: currentBranch, tip, pr: null, parentTip },
			isTop: true,
			isBottom: stack.branches.length === 1,
		});
		return 0;
	}
}
