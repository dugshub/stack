import { Command, Option } from 'clipanion';
import { resolveBase } from '../lib/base-resolver.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeDependentStacks, cascadeRebase, rebaseBranch } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState, stackParents } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { RestackState, StackFile, StackParent } from '../lib/types.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class BaseCommand extends Command {
	static override paths = [['stack', 'base'], ['base']];

	static override usage = Command.Usage({
		description: 'Change the stack’s base branch (re-parent)',
		examples: [
			['Reparent onto main', 'st base main'],
			['Reparent onto another integration branch', 'st base develop'],
			['Reparent onto a branch in another stack (dependent)', 'st base user/other-stack/3-final'],
			['Reparent onto the current branch', 'st base .'],
			['Explicit stack target', 'st base --stack my-stack main'],
			['Preview without mutating', 'st base --dry-run main'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show what would happen without making changes',
	});

	cascade = Option.Boolean('--cascade', true, {
		description: 'Cascade rebase to dependent stacks',
	});

	newBase = Option.String({ required: true });

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

		const { stackName: resolvedName, stack } = resolved;

		// 2. Reject if a restack is in progress.
		if (stack.restackState) {
			ui.error(
				`A restack is in progress. Run ${theme.command('st continue')} or ${theme.command('st abort')} first.`,
			);
			return 2;
		}

		// 3. Reject multi-parent stacks (phase-1 limitation).
		if (stackParents(stack).length > 1) {
			ui.error('Multi-parent stacks cannot be re-parented yet — coming in phase 2.');
			return 2;
		}

		// 4. Resolve <new-base> (shared with `st create --base`), including
		// the self-reference check against this stack.
		const baseResult = resolveBase({
			state,
			base: this.newBase,
			selfStackName: resolvedName,
		});
		if (baseResult.error) {
			ui.error(baseResult.error);
			return 2;
		}
		if (!baseResult.trunk) {
			// resolveBase returns {} only when base is undefined; we required it.
			ui.error('Could not resolve new base.');
			return 2;
		}

		const newTrunk = baseResult.trunk;
		const newPrimary = baseResult.primary;

		// Cycle detection: if the new primary parent's stack (transitively)
		// depends on our stack, reject.
		if (newPrimary) {
			const cycle = this.detectCycle(state, newPrimary.stack, resolvedName);
			if (cycle) {
				ui.error(
					`Circular dependency: "${resolvedName}" would depend on "${newPrimary.stack}" which already depends on it`,
				);
				return 2;
			}
		}

		const newDependsOn: StackParent[] | undefined = newPrimary ? [newPrimary] : undefined;
		const currentDependsOn = stack.dependsOn;

		// 5. No-op check: trunk matches AND dependsOn structurally matches.
		if (newTrunk === stack.trunk && dependsOnEqual(currentDependsOn, newDependsOn)) {
			ui.info(`Stack "${resolvedName}" is already based on ${theme.branch(newTrunk)}.`);
			return 0;
		}

		// 6. Dry-run: print current vs proposed state.
		if (this.dryRun) {
			ui.heading('Current:');
			ui.info(`  trunk: ${stack.trunk}`);
			if (currentDependsOn && currentDependsOn.length > 0) {
				for (const p of currentDependsOn) {
					ui.info(`  dependsOn: ${p.stack} (${p.branch})`);
				}
			} else {
				ui.info('  dependsOn: (none — standalone)');
			}

			ui.heading('Proposed:');
			ui.info(`  trunk: ${newTrunk}`);
			if (newDependsOn && newDependsOn.length > 0) {
				for (const p of newDependsOn) {
					ui.info(`  dependsOn: ${p.stack} (${p.branch})`);
				}
			} else {
				ui.info('  dependsOn: (none — standalone)');
			}

			ui.heading('Branches to rebase:');
			for (let i = 0; i < stack.branches.length; i++) {
				const b = stack.branches[i];
				if (!b) continue;
				const parentRef = i === 0 ? newTrunk : (stack.branches[i - 1]?.name ?? newTrunk);
				ui.info(`  ${i + 1}. ${b.name} (onto ${parentRef})`);
			}

			return 0;
		}

		// 7. Save undo snapshot.
		saveSnapshot('base');

		// 8. Update the first branch's PR base on GitHub FIRST, before any
		// local mutation or rebase. This keeps the PR state correct even if
		// the rebase hits conflicts mid-stack (st continue does not re-run
		// PR-base updates).
		const firstBranch = stack.branches[0];
		if (firstBranch?.pr != null) {
			try {
				gh.prEdit(firstBranch.pr, { base: newTrunk });
				ui.success(
					`Updated PR #${firstBranch.pr} base to ${theme.branch(newTrunk)}`,
				);
			} catch (err) {
				ui.warn(
					`Failed to update PR #${firstBranch.pr} base: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// 9. Restack onto the new base.
		// Snapshot old tips BEFORE mutating state.
		const oldTips: Record<string, string> = {};
		for (const branch of stack.branches) {
			const tip = branch.tip ?? git.revParse(branch.name);
			oldTips[branch.name] = tip;
		}

		// Mutate stack.trunk and stack.dependsOn, then persist so the mutation
		// is durable even if the rebase hits a conflict.
		stack.trunk = newTrunk;
		if (newDependsOn && newDependsOn.length > 0) {
			stack.dependsOn = newDependsOn;
		} else {
			delete stack.dependsOn;
		}
		stack.updated = new Date().toISOString();
		saveState(state);

		const worktreeMap = git.worktreeList();

		// Rebase the first branch onto the new trunk.
		if (firstBranch) {
			ui.info(
				`Rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(newTrunk)}...`,
			);
			const result = rebaseBranch({
				branch: firstBranch,
				parentRef: newTrunk,
				fallbackOldBase: oldTips[firstBranch.name],
				worktreeMap,
			});
			if (result.ok) {
				if (firstBranch.tip) oldTips[firstBranch.name] = firstBranch.tip;
				ui.success(`Rebased ${theme.branch(firstBranch.name)}`);
			} else {
				const restackState: RestackState = {
					fromIndex: -1,
					currentIndex: 0,
					oldTips,
				};
				stack.restackState = restackState;
				saveState(state);
				ui.error(
					`Conflict rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(newTrunk)}`,
				);
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

		// Cascade rebase the remaining branches.
		const cascadeResult = cascadeRebase({
			state,
			stack,
			fromIndex: -1,
			startIndex: 1,
			worktreeMap,
			oldTips,
		});

		if (!cascadeResult.ok) {
			return 1;
		}

		// Refresh commit statuses (merge-ready / rebase-status).
		gh.updateMergeReadyStatuses(state.repo, stack.branches, stack.trunk);

		// 10. Cascade to dependent stacks.
		await cascadeDependentStacks(state, resolvedName, this.cascade, new Set());

		// 11. Success output.
		ui.success(
			`Stack ${theme.stack(resolvedName)} now based on ${theme.branch(newTrunk)}`,
		);
		if (newDependsOn && newDependsOn.length > 0) {
			for (const p of newDependsOn) {
				ui.info(`  Depends on: ${theme.stack(p.stack)} (${theme.branch(p.branch)})`);
			}
		}

		return 0;
	}

	/**
	 * Walk `dependsOn` transitively from `startStack`. If `targetStack`
	 * appears anywhere in the chain, we have a cycle.
	 *
	 * Not using `findDependentStacks` (state.ts) because that's one-level.
	 */
	private detectCycle(
		state: StackFile,
		startStack: string,
		targetStack: string,
	): boolean {
		const visited = new Set<string>();
		const queue: string[] = [startStack];

		while (queue.length > 0) {
			const current = queue.shift();
			if (!current || visited.has(current)) continue;
			visited.add(current);

			if (current === targetStack) return true;

			const s = state.stacks[current];
			if (!s?.dependsOn) continue;
			for (const parent of s.dependsOn) {
				if (!visited.has(parent.stack)) {
					queue.push(parent.stack);
				}
			}
		}

		return false;
	}
}

function dependsOnEqual(
	a: StackParent[] | undefined,
	b: StackParent[] | undefined,
): boolean {
	const aLen = a?.length ?? 0;
	const bLen = b?.length ?? 0;
	if (aLen !== bLen) return false;
	if (aLen === 0) return true;
	for (let i = 0; i < aLen; i++) {
		const ai = a?.[i];
		const bi = b?.[i];
		if (!ai || !bi) return false;
		if (ai.stack !== bi.stack || ai.branch !== bi.branch) return false;
	}
	return true;
}
