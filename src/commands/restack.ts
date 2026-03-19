import { isatty } from 'node:tty';
import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeRebase, rebaseBranch } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { findActiveStack, findDependentStacks, loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { RestackState, StackFile } from '../lib/types.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class RestackCommand extends Command {
	static override paths = [['restack']];

	static override usage = Command.Usage({
		description: 'Rebase downstream branches after amending a stack branch',
		examples: [
			['Restack downstream branches', 'stack restack'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	cascade = Option.Boolean('--cascade', true, {
		description: 'Cascade restack to dependent stacks',
	});

	async execute(): Promise<number> {
		const originalBranch = git.currentBranch();

		// Verify clean working tree
		if (git.isDirty()) {
			ui.error(
				'Working tree is dirty. Commit or stash changes before restacking.',
			);
			return 2;
		}

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
			ui.error('A restack is already in progress. Use `stack continue` or `stack abort`.');
			return 2;
		}

		// Determine fromIndex: position.index if on a branch, -1 to restack all from bottom
		const fromIndex = position?.index ?? -1;

		// Nothing to restack if we're at the top
		if (position && position.isTop) {
			ui.info('Already at top of stack -- nothing to restack.');
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
						`Resolve conflicts, stage files, then run ${theme.command('stack continue')}.`,
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
			// Return to the original branch
			git.checkout(originalBranch);
			// Refresh commit statuses
			gh.updateMergeReadyStatuses(state.repo, stack.branches, stack.trunk);
			ui.success(
				`Restacked ${cascadeResult.rebased + (fromIndex === -1 && stack.branches.length > 0 ? 1 : 0)} branches in "${resolvedName}"`,
			);
			await this.cascadeDependentStacks(state, resolvedName, this.cascade, new Set());
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
