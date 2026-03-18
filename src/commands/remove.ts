import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class RemoveCommand extends Command {
	static override paths = [['remove']];

	static override usage = Command.Usage({
		description: 'Remove a branch from the active stack',
		examples: [
			['Remove current branch', 'stack remove'],
			['Remove a specific branch', 'stack remove user/stack/2-feature'],
			['Also delete the git branch', 'stack remove --branch'],
			['Also close the PR', 'stack remove --pr'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	branchArg = Option.String({ required: false });

	deleteBranch = Option.Boolean('--branch', false, {
		description: 'Also delete the git branch (local + remote)',
	});

	closePr = Option.Boolean('--pr', false, {
		description: 'Also close the PR',
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackName });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName: resolvedName, stack, position } = resolved;

		// If position is null (not on a stack branch) and no branchArg, error
		if (!position && !this.branchArg) {
			ui.error('Specify which branch to remove.');
			return 2;
		}

		// Block if restack is in progress
		if (stack.restackState) {
			ui.error(
				'Cannot remove branches while a restack is in progress. ' +
					`Run ${theme.command('stack continue')} or ${theme.command('stack abort')} first.`,
			);
			return 2;
		}

		saveSnapshot('remove');

		// Resolve which branch to remove
		const targetName = this.branchArg ?? git.currentBranch();
		const targetIndex = stack.branches.findIndex(
			(b) => b.name === targetName,
		);

		if (targetIndex === -1) {
			ui.error(
				`Branch "${targetName}" is not in stack ${theme.stack(resolvedName)}.`,
			);
			return 2;
		}

		const target = stack.branches[targetIndex];
		if (!target) {
			ui.error('Could not resolve target branch.');
			return 2;
		}

		// Warn if other stacks depend on this branch
		const dependentStacks = Object.entries(state.stacks)
			.filter(([, s]) => s.dependsOn?.branch === target.name)
			.map(([name]) => name);
		if (dependentStacks.length > 0) {
			ui.warn(
				`${dependentStacks.length} stack(s) depend on branch "${target.name}": ${dependentStacks.join(', ')}`,
			);
			ui.info('Those stacks will lose their dependency link to this branch.');
		}

		// Retarget downstream PR's base
		const downstream = stack.branches[targetIndex + 1];
		if (downstream?.pr != null) {
			// New parent: previous branch, or trunk if removing the bottom
			const newBase =
				targetIndex > 0
					? (stack.branches[targetIndex - 1]?.name ?? stack.trunk)
					: stack.trunk;
			try {
				gh.prEdit(downstream.pr, { base: newBase });
				ui.success(
					`Retargeted ${theme.pr(`#${downstream.pr}`)} to ${theme.branch(newBase)}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ui.warn(
					`Failed to retarget ${theme.pr(`#${downstream.pr}`)}: ${msg}`,
				);
			}
		}

		// Close PR if requested
		if (this.closePr && target.pr != null) {
			try {
				gh.prClose(target.pr);
				ui.success(`Closed ${theme.pr(`#${target.pr}`)}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ui.warn(`Failed to close ${theme.pr(`#${target.pr}`)}: ${msg}`);
			}
		}

		// If removing current branch, navigate away first
		const currentBranch = git.currentBranch();
		if (currentBranch === target.name) {
			// Go to adjacent branch or trunk
			const adjacent =
				stack.branches[targetIndex - 1] ??
				stack.branches[targetIndex + 1];
			const checkoutTarget = adjacent?.name ?? stack.trunk;
			git.checkout(checkoutTarget);
			ui.info(`Checked out ${theme.branch(checkoutTarget)}`);
		}

		// Delete git branch if requested
		if (this.deleteBranch) {
			try {
				git.deleteBranch(target.name, { remote: true });
				ui.success(`Deleted branch ${theme.branch(target.name)}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ui.warn(`Failed to delete ${theme.branch(target.name)}: ${msg}`);
			}
		}

		// Remove from state
		stack.branches.splice(targetIndex, 1);
		stack.updated = new Date().toISOString();

		// If stack is now empty, remove it entirely
		if (stack.branches.length === 0) {
			delete state.stacks[resolvedName];
			if (state.currentStack === resolvedName) {
				state.currentStack = null;
			}
			saveState(state);
			ui.success(
				`Removed last branch from stack ${theme.stack(resolvedName)} -- stack deleted.`,
			);
			return 0;
		}

		saveState(state);
		ui.success(
			`Removed ${theme.branch(target.name)} from stack ${theme.stack(resolvedName)} (${stack.branches.length} branches remaining).`,
		);
		return 0;
	}
}
