import { isatty } from 'node:tty';
import * as p from '@clack/prompts';
import * as git from './git.js';
import { findDependentStacks, primaryParent, saveState } from './state.js';
import { theme } from './theme.js';
import type { Branch, RestackState, Stack, StackFile } from './types.js';
import * as ui from './ui.js';
import { saveSnapshot } from './undo.js';

interface RebaseBranchOpts {
	branch: Branch;
	parentRef: string; // parent branch name or trunk
	fallbackOldBase?: string; // for pre-migration branches without parentTip
	worktreeMap?: Map<string, string>;
}

interface RebaseBranchResult {
	ok: boolean;
	conflicts: string[];
}

export function rebaseBranch(opts: RebaseBranchOpts): RebaseBranchResult {
	const { branch, parentRef, fallbackOldBase, worktreeMap } = opts;
	const worktreePath = worktreeMap?.get(branch.name);

	// Fork point: parentTip (correct) → fallback (legacy) → merge-base (last resort)
	// Validate parentTip is still reachable from the branch — it can become stale
	// if the user rebased outside of `st restack` (e.g. `git rebase origin/main`).
	const parentTip =
		branch.parentTip && git.isAncestor(branch.parentTip, branch.name)
			? branch.parentTip
			: undefined;
	const mergeBaseResult = git.tryRun('merge-base', parentRef, branch.name);
	const oldBase =
		parentTip ??
		fallbackOldBase ??
		(mergeBaseResult.ok ? mergeBaseResult.stdout : null);

	if (!oldBase) {
		return { ok: false, conflicts: [] };
	}

	const result = git.rebaseOnto(parentRef, oldBase, branch.name, {
		cwd: worktreePath,
	});

	if (result.ok) {
		branch.tip = git.revParse(branch.name, {
			cwd: worktreePath ?? undefined,
		});
		// parentRef is a branch/trunk name — rev-parse works from any worktree (shared refs)
		branch.parentTip = git.revParse(parentRef);
	}

	return result;
}

interface CascadeOpts {
	state: StackFile;
	stack: Stack;
	fromIndex: number; // the amended branch index (-1 = all from bottom)
	startIndex: number; // where to begin iterating (fromIndex+1 for normal, currentIndex for continue)
	worktreeMap: Map<string, string>;
	oldTips: Record<string, string>; // legacy fallback tips (mutated as side-effect)
}

interface CascadeResult {
	ok: boolean;
	rebased: number;
	conflictBranch?: string;
	conflicts?: string[];
}

export function cascadeRebase(opts: CascadeOpts): CascadeResult {
	const { state, stack, fromIndex, startIndex, worktreeMap, oldTips } = opts;
	let rebased = 0;

	for (let i = startIndex; i < stack.branches.length; i++) {
		const branch = stack.branches[i];
		if (!branch) continue;

		const parentBranch = stack.branches[i - 1];
		const parentRef = parentBranch?.name ?? stack.trunk;

		ui.info(
			`Rebasing ${theme.branch(branch.name)} onto ${theme.branch(parentRef)}...`,
		);

		const result = rebaseBranch({
			branch,
			parentRef,
			fallbackOldBase: parentBranch ? oldTips[parentBranch.name] : undefined,
			worktreeMap,
		});

		if (result.ok) {
			// Update oldTips so downstream iterations and restackState have current values
			if (branch.tip) oldTips[branch.name] = branch.tip;
			rebased++;
			saveState(state);
			ui.success(`Rebased ${theme.branch(branch.name)}`);
		} else {
			// Save restackState for --continue (fromIndex passed through from caller)
			stack.restackState = {
				fromIndex,
				currentIndex: i,
				oldTips,
			};
			saveState(state);
			ui.error(`Conflict rebasing ${theme.branch(branch.name)}`);
			if (result.conflicts.length > 0) {
				ui.info('Conflicting files:');
				for (const file of result.conflicts) {
					ui.info(`  ${file}`);
				}
			}
			ui.info(
				`Resolve conflicts, stage files, then run ${theme.command('st continue')}.`,
			);
			return {
				ok: false,
				rebased,
				conflictBranch: branch.name,
				conflicts: result.conflicts,
			};
		}
	}

	// Clear restackState on completion
	stack.restackState = null;
	stack.updated = new Date().toISOString();
	saveState(state);

	return { ok: true, rebased };
}

/**
 * Cascade a restack to stacks that depend on the given stack.
 *
 * For each dependent stack, optionally prompt (on TTY) before rebasing, then
 * rebase all branches onto the dependent's trunk. Recurses into further
 * dependents after each successful cascade. On conflict, persists
 * `restackState` and returns early — the caller should exit 1 so the user
 * sees the standard "run `st continue`" hint.
 *
 * Extracted from the previously-duplicated private methods on
 * `RestackCommand` and `ContinueCommand` so `restack`, `continue`, and `base`
 * share one implementation.
 */
export async function cascadeDependentStacks(
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

		const depBranch = primaryParent(depStack)?.branch ?? depStack.trunk;
		process.stderr.write('\n');
		ui.info(`Stack "${depName}" depends on "${stackName}" (via ${theme.branch(depBranch)})`);

		if (!cascade) {
			ui.info(`Tip: Run ${theme.command(`st restack -s ${depName}`)} to update it.`);
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
					ui.info(`Resolve conflicts, stage files, then run ${theme.command('st continue')}.`);
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
			await cascadeDependentStacks(state, depName, cascade, visited);
		} else {
			return;
		}
	}
}
