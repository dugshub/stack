import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeDependentStacks, cascadeRebase } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { findDependentStacks, loadAndRefreshState, stackParents } from '../lib/state.js';
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

		if (stack.restackState) {
			ui.error('A restack is already in progress. Use `st continue` or `st abort`.');
			return 2;
		}

		// Determine fromIndex: position.index if on a branch, -1 to restack all from bottom
		const fromIndex = position?.index ?? -1;

		// Nothing to restack internally if we're at the top, but still cascade to dependents.
		// Exception: a diamond's join branch (index 0) may need a re-merge even when it's
		// the only branch in the stack, because parent tips could have moved.
		const isDiamondJoin =
			position?.index === 0 && stackParents(stack).length > 1;
		if (position && position.isTop && !isDiamondJoin) {
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

		// Cascade handles index 0 internally — trunk-rebase for linear, join-merge
		// for diamond. When the user is ON the join branch, also start at 0 so the
		// merge gets recreated.
		const cascadeStart =
			fromIndex === -1 || isDiamondJoin ? 0 : fromIndex + 1;
		const cascadeResult = cascadeRebase({
			state,
			stack,
			fromIndex,
			startIndex: cascadeStart,
			worktreeMap,
			oldTips,
		});

		if (cascadeResult.ok) {
			// Refresh commit statuses
			gh.updateMergeReadyStatuses(state.repo, stack.branches, stack.trunk);
			ui.success(
				`Restacked ${cascadeResult.rebased} branches in "${resolvedName}"`,
			);
			await cascadeDependentStacks(state, resolvedName, this.cascade, new Set());
		}

		return cascadeResult.ok ? 0 : 1;
	}
}
