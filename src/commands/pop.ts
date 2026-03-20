import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class PopCommand extends Command {
	static override paths = [['branch', 'pop'], ['pop']];

	static override usage = Command.Usage({
		description: 'Remove current branch from stack, keeping changes in working tree',
		examples: [
			['Pop current branch', 'st pop'],
			['Pop and close PR', 'st pop --close'],
		],
	});

	close = Option.Boolean('--close', false, {
		description: 'Also close the PR if one exists',
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		if (!position) {
			ui.error('Not on a stack branch.');
			return 2;
		}

		const stack = state.stacks[position.stackName];
		if (!stack) {
			ui.error('Stack not found in state.');
			return 2;
		}

		const currentBranch = stack.branches[position.index];
		if (!currentBranch) {
			ui.error('Could not find current branch in stack.');
			return 2;
		}

		// Block if restack is in progress
		if (stack.restackState) {
			ui.error(
				'Cannot pop branches while a restack is in progress. ' +
					`Run ${theme.command('st continue')} or ${theme.command('st abort')} first.`,
			);
			return 2;
		}

		// Determine parent ref
		const parentBranch =
			position.index > 0 ? stack.branches[position.index - 1] : null;
		const parentRef = parentBranch?.name ?? stack.trunk;

		saveSnapshot('pop');

		// Create a patch of this branch's changes relative to parent
		// Include uncommitted changes by diffing against working tree (no HEAD)
		const patchResult = git.tryRun('diff', parentRef);

		// Handle PR: warn or close
		if (currentBranch.pr != null) {
			if (this.close) {
				try {
					gh.prClose(currentBranch.pr);
					ui.success(`Closed PR ${theme.pr(`#${currentBranch.pr}`)}`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ui.warn(
						`Could not close PR ${theme.pr(`#${currentBranch.pr}`)}: ${msg}`,
					);
				}
			} else {
				ui.warn(
					`Branch has PR ${theme.pr(`#${currentBranch.pr}`)}. Use --close to also close it.`,
				);
			}
		}

		// Retarget downstream PR's base (same pattern as remove.ts)
		const downstream = stack.branches[position.index + 1];
		if (downstream?.pr != null) {
			try {
				gh.prEdit(downstream.pr, { base: parentRef });
				ui.success(
					`Retargeted ${theme.pr(`#${downstream.pr}`)} to ${theme.branch(parentRef)}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ui.warn(
					`Failed to retarget ${theme.pr(`#${downstream.pr}`)}: ${msg}`,
				);
			}
		}

		// Stash any dirty state so checkout succeeds
		const wasDirty = git.isDirty();
		if (wasDirty) {
			git.run('stash', '--include-untracked');
		}

		// Check out parent
		git.checkout(parentRef);

		// Apply the patch to working tree (don't commit)
		if (patchResult.ok && patchResult.stdout.length > 0) {
			const applyResult = Bun.spawnSync(['git', 'apply', '--index'], {
				stdin: Buffer.from(patchResult.stdout),
				stdout: 'pipe',
				stderr: 'pipe',
			});
			if (applyResult.exitCode !== 0) {
				// Try without --index (just working tree)
				const applyWt = Bun.spawnSync(['git', 'apply'], {
					stdin: Buffer.from(patchResult.stdout),
					stdout: 'pipe',
					stderr: 'pipe',
				});
				if (applyWt.exitCode !== 0) {
					// Restore stashed changes if possible
					if (wasDirty) {
						git.tryRun('stash', 'pop');
					}
					ui.warn(
						'Could not cleanly apply changes to working tree. Changes may need manual recovery.',
					);
					ui.info(
						`The original branch "${currentBranch.name}" has NOT been deleted.`,
					);
					// Still remove from stack state but don't delete the branch
					stack.branches.splice(position.index, 1);
					stack.updated = new Date().toISOString();
					if (stack.branches.length === 0) {
						delete state.stacks[position.stackName];
						if (state.currentStack === position.stackName) {
							state.currentStack = null;
						}
					}
					saveState(state);
					return 1;
				}
			}
		}

		// Drop the stash — changes are now in the applied patch
		if (wasDirty) {
			git.tryRun('stash', 'drop');
		}

		// Delete the local branch (not remote — user may have a PR)
		git.tryRun('branch', '-D', currentBranch.name);

		// Remove branch from state
		stack.branches.splice(position.index, 1);
		stack.updated = new Date().toISOString();

		// If stack is now empty, remove it entirely
		if (stack.branches.length === 0) {
			delete state.stacks[position.stackName];
			if (state.currentStack === position.stackName) {
				state.currentStack = null;
			}
			saveState(state);
			ui.success(
				`Popped ${theme.branch(currentBranch.name)} from stack ${theme.stack(position.stackName)} -- stack deleted.`,
			);
			ui.info(`Now on ${theme.branch(parentRef)} with changes in working tree.`);
			return 0;
		}

		saveState(state);

		ui.success(
			`Popped ${theme.branch(currentBranch.name)} from stack ${theme.stack(position.stackName)} (${stack.branches.length} branches remaining).`,
		);
		ui.info(`Now on ${theme.branch(parentRef)} with changes in working tree.`);

		return 0;
	}
}
