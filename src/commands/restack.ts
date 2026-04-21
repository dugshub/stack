import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeDependentStacks, cascadeRebase, rebaseBranch } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { findDependentStacks, loadAndRefreshState, saveState, stackParents } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { RestackState } from '../lib/types.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class RestackCommand extends Command {
	static override paths = [['stack', 'restack'], ['restack']];

	static override usage = Command.Usage({
		description: 'Rebase downstream branches after amending a stack branch',
		examples: [
			['Restack downstream branches', 'st restack'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	cascade = Option.Boolean('--cascade', true, {
		description: 'Cascade restack to dependent stacks',
	});

	async execute(): Promise<number> {
		return git.withCleanWorktreeAsync(() => this.executeInner());
	}

	private async executeInner(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackName });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName: resolvedName, stack, position } = resolved;

		if (stackParents(stack).length > 1) {
			ui.error('Multi-parent stacks cannot be restacked yet — coming in phase 2.');
			return 2;
		}

		if (stack.restackState) {
			ui.error('A restack is already in progress. Use `st continue` or `st abort`.');
			return 2;
		}

		// Determine fromIndex: position.index if on a branch, -1 to restack all from bottom
		const fromIndex = position?.index ?? -1;

		// Nothing to restack internally if we're at the top, but still cascade to dependents
		if (position && position.isTop) {
			const dependents = findDependentStacks(state, resolvedName);
			if (this.cascade && dependents.length > 0) {
				await cascadeDependentStacks(state, resolvedName, this.cascade, new Set());
			} else {
				ui.info('Already at top of stack -- nothing to restack.');
			}
			return 0;
		}

		saveSnapshot('restack');

		// Snapshot old tips for all branches from fromIndex onward
		const startIndex = fromIndex === -1 ? 0 : fromIndex;
		const oldTips: Record<string, string> = {};
		for (let i = startIndex; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch) continue;
			const tip = branch.tip ?? git.revParse(branch.name);
			oldTips[branch.name] = tip;
		}

		// Build worktree map
		const worktreeMap = git.worktreeList();

		// If restacking from bottom (fromIndex === -1), rebase first branch onto trunk
		if (fromIndex === -1 && stack.branches.length > 0) {
			const firstBranch = stack.branches[0];
			if (firstBranch) {
				ui.info(`Rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}...`);
				const result = rebaseBranch({
					branch: firstBranch,
					parentRef: stack.trunk,
					fallbackOldBase: oldTips[firstBranch.name],
					worktreeMap,
				});
				if (result.ok) {
					if (firstBranch.tip) oldTips[firstBranch.name] = firstBranch.tip;
					ui.success(`Rebased ${theme.branch(firstBranch.name)}`);
				} else {
					const restackState: RestackState = {
						fromIndex,
						currentIndex: 0,
						oldTips,
					};
					stack.restackState = restackState;
					saveState(state);
					ui.error(`Conflict rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}`);
					if (result.conflicts.length > 0) {
						ui.info('Conflicting files:');
						for (const file of result.conflicts) {
							ui.info(`  ${file}`);
						}
					}
					ui.info(
						`Resolve conflicts, stage files, then run ${theme.command('st continue')}.`,
					);
					return 1;
				}
			}
		}

		// Cascade rebase for each downstream branch
		const cascadeResult = cascadeRebase({
			state,
			stack,
			fromIndex,
			startIndex: fromIndex === -1 ? 1 : fromIndex + 1,
			worktreeMap,
			oldTips,
		});

		if (cascadeResult.ok) {
			// Refresh commit statuses
			gh.updateMergeReadyStatuses(state.repo, stack.branches, stack.trunk);
			ui.success(
				`Restacked ${cascadeResult.rebased + (fromIndex === -1 && stack.branches.length > 0 ? 1 : 0)} branches in "${resolvedName}"`,
			);
			await cascadeDependentStacks(state, resolvedName, this.cascade, new Set());
		}

		return cascadeResult.ok ? 0 : 1;
	}
}
