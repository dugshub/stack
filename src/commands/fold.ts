import { Command } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeRebase } from '../lib/rebase.js';
import { findActiveStack, loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class FoldCommand extends Command {
	static override paths = [['branch', 'fold'], ['fold']];

	static override usage = Command.Usage({
		description: 'Merge current branch into its parent branch',
		examples: [['Fold current branch into parent', 'st fold']],
	});

	async execute(): Promise<number> {
		// Require clean working tree
		if (git.isDirty()) {
			ui.error(
				'Working tree is dirty. Commit or stash changes before folding.',
			);
			return 2;
		}

		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		if (!position) {
			ui.error('Not on a stack branch.');
			return 2;
		}

		const stack = state.stacks[position.stackName];
		if (!stack) {
			ui.error('Stack not found.');
			return 2;
		}

		// Block if restack is in progress
		if (stack.restackState) {
			ui.error(
				'Cannot fold branches while a restack is in progress. ' +
					`Run ${theme.command('st continue')} or ${theme.command('st abort')} first.`,
			);
			return 2;
		}

		// Can't fold the bottom branch (no parent branch in the stack to fold into)
		if (position.isBottom) {
			ui.error(
				'Cannot fold the bottom branch — there is no parent branch in the stack to fold into.',
			);
			return 2;
		}

		const currentBranch = stack.branches[position.index];
		const parentBranch = stack.branches[position.index - 1];
		if (!currentBranch || !parentBranch) {
			ui.error('Could not determine current or parent branch.');
			return 2;
		}

		saveSnapshot('fold');

		// Check out parent and fast-forward merge
		git.checkout(parentBranch.name);
		const mergeResult = git.tryRun('merge', '--ff-only', currentBranch.name);
		if (!mergeResult.ok) {
			// If ff-only fails, try a regular merge
			const result = git.tryRun('merge', currentBranch.name, '--no-edit');
			if (!result.ok) {
				ui.error('Could not merge branch into parent. Resolve manually.');
				git.tryRun('merge', '--abort');
				return 2;
			}
		}

		// Update parent's tip in state
		parentBranch.tip = git.revParse('HEAD');

		// Close PR if one exists
		if (currentBranch.pr != null) {
			try {
				gh.prClose(currentBranch.pr);
				ui.info(`Closed PR ${theme.pr(`#${currentBranch.pr}`)}`);
			} catch (err) {
				ui.warn(
					`Could not close PR ${theme.pr(`#${currentBranch.pr}`)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Retarget downstream PR base to parent (before deleting the branch)
		const downstream = stack.branches[position.index + 1];
		if (downstream?.pr != null) {
			try {
				gh.prEdit(downstream.pr, { base: parentBranch.name });
				ui.success(
					`Retargeted ${theme.pr(`#${downstream.pr}`)} to ${theme.branch(parentBranch.name)}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ui.warn(
					`Failed to retarget ${theme.pr(`#${downstream.pr}`)}: ${msg}`,
				);
			}
		}

		// Delete the folded branch (local + remote)
		git.deleteBranch(currentBranch.name, { remote: true });

		// Remove branch from state
		stack.branches.splice(position.index, 1);
		stack.updated = new Date().toISOString();
		saveState(state);

		ui.success(
			`Folded ${theme.branch(currentBranch.name)} into ${theme.branch(parentBranch.name)}`,
		);

		// Restack downstream branches if any exist after the folded branch
		if (position.index < stack.branches.length) {
			ui.info('Restacking downstream branches...');

			const oldTips: Record<string, string> = {};
			for (let i = position.index; i < stack.branches.length; i++) {
				const branch = stack.branches[i];
				if (!branch) continue;
				const tip = branch.tip ?? git.revParse(branch.name);
				oldTips[branch.name] = tip;
			}

			const worktreeMap = git.worktreeList();

			// The parent is now at position.index - 1 and downstream starts at position.index
			// (since we removed the current branch, what was at position.index + 1 is now at position.index)
			const cascadeResult = cascadeRebase({
				state,
				stack,
				fromIndex: position.index - 1,
				startIndex: position.index,
				worktreeMap,
				oldTips,
			});

			if (cascadeResult.ok) {
				ui.success(
					`Restacked ${cascadeResult.rebased} downstream branch(es)`,
				);
			} else {
				ui.warn('Downstream restack had conflicts.');
				ui.info(
					`Resolve conflicts, then run ${theme.command('st continue')}.`,
				);
				return 1;
			}
		}

		// Report new position
		if (stack.branches.length === 0) {
			ui.info('Stack is now empty.');
		} else {
			const parentIndex = position.index - 1;
			ui.positionReport({
				stackName: position.stackName,
				index: parentIndex,
				total: stack.branches.length,
				branch: parentBranch,
				isTop: parentIndex === stack.branches.length - 1,
				isBottom: parentIndex === 0,
			});
		}

		return 0;
	}
}
