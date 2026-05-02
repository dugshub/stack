import { isatty } from 'node:tty';
import * as p from '@clack/prompts';
import * as git from './git.js';
import { findDependentStacks, primaryParent, saveState, stackParents } from './state.js';
import { theme } from './theme.js';
import type { Branch, Stack, StackFile } from './types.js';
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

interface RebaseJoinResult {
	ok: boolean;
	conflicts?: string[];
	phase?: 'merging' | 'replaying';
	skipped?: boolean;
}

function findMergeSha(branchName: string): string | null {
	const result = git.tryRun(
		'log',
		'--first-parent',
		'--merges',
		'-n',
		'1',
		'--format=%H',
		branchName,
	);
	if (!result.ok || !result.stdout) return null;
	return result.stdout;
}

export function rebaseJoinBranch(
	state: StackFile,
	stack: Stack,
	branch: Branch,
): RebaseJoinResult {
	const parents = stackParents(stack);
	if (parents.length < 2) {
		ui.error(`${theme.branch(branch.name)} is not a join branch`);
		return { ok: false };
	}
	const primary = parents[0]!;
	const secondaries = parents.slice(1);

	const newTips: Record<string, string> = {};
	for (const p of parents) {
		newTips[p.branch] = git.revParse(p.branch);
	}
	const oldTips = branch.parentTips ?? {};

	const moved = parents.some((p) => newTips[p.branch] !== oldTips[p.branch]);
	if (!moved) {
		return { ok: true, skipped: true };
	}

	const oldJoinTip = git.revParse(branch.name);
	const oldMergeSha =
		branch.joinMergeSha ?? findMergeSha(branch.name) ?? oldJoinTip;

	git.checkout(branch.name);
	const resetResult = git.tryRun('reset', '--hard', newTips[primary.branch]!);
	if (!resetResult.ok) {
		ui.error(`Failed to reset ${theme.branch(branch.name)} to primary parent tip`);
		return { ok: false };
	}

	// Save partial state before the merge so a conflict lands resumable.
	const baseRestackState = stack.restackState ?? {
		fromIndex: -1,
		currentIndex: 0,
		oldTips: {},
	};
	stack.restackState = {
		...baseRestackState,
		joinState: {
			branchName: branch.name,
			phase: 'merging',
			oldJoinTip,
			oldMergeSha,
			parentTipsAtStart: newTips,
		},
	};
	saveState(state);

	const mergeArgs = [
		'merge',
		'--no-ff',
		'-m',
		'Merge parents for diamond stack',
		...secondaries.map((s) => newTips[s.branch]!),
	];
	const mergeResult = git.tryRun(...mergeArgs);
	if (!mergeResult.ok) {
		const conflicts = mergeResult.stdout
			.split('\n')
			.filter((l) => l.startsWith('CONFLICT'));
		return { ok: false, conflicts, phase: 'merging' };
	}

	const newMergeSha = git.revParse('HEAD');

	if (oldJoinTip !== oldMergeSha) {
		stack.restackState = {
			...stack.restackState!,
			joinState: {
				...stack.restackState!.joinState!,
				phase: 'replaying',
				newMergeSha,
			},
		};
		saveState(state);
		const cp = git.tryRun('cherry-pick', `${oldMergeSha}..${oldJoinTip}`);
		if (!cp.ok) {
			const conflicts = cp.stdout
				.split('\n')
				.filter((l) => l.startsWith('CONFLICT'));
			return { ok: false, conflicts, phase: 'replaying' };
		}
	}

	branch.tip = git.revParse(branch.name);
	branch.parentTips = newTips;
	branch.joinMergeSha = newMergeSha;
	branch.parentTip = newTips[primary.branch]!;
	return { ok: true };
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

		// Diamond handling for i === 0: join-branch rebase.
		if (i === 0 && stackParents(stack).length > 1) {
			ui.info(
				`Rebasing join branch ${theme.branch(branch.name)} onto parents...`,
			);
			const joinResult = rebaseJoinBranch(state, stack, branch);
			if (joinResult.ok) {
				if (!joinResult.skipped) {
					if (branch.tip) oldTips[branch.name] = branch.tip;
					rebased++;
					saveState(state);
					ui.success(`Rebased ${theme.branch(branch.name)}`);
				} else {
					ui.info(
						`No parent tips moved for ${theme.branch(branch.name)} — skipping`,
					);
				}
				continue;
			}
			if (stack.restackState) {
				stack.restackState.fromIndex = fromIndex;
				stack.restackState.currentIndex = i;
			}
			saveState(state);
			ui.error(
				`Conflict during ${joinResult.phase ?? 'merging'} of ${theme.branch(branch.name)}`,
			);
			if (joinResult.conflicts && joinResult.conflicts.length > 0) {
				ui.info('Conflicting files:');
				for (const file of joinResult.conflicts) {
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
				conflicts: joinResult.conflicts,
			};
		}

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

		const cascadeResult = cascadeRebase({
			state,
			stack: depStack,
			fromIndex: -1,
			startIndex: 0,
			worktreeMap,
			oldTips,
		});

		if (cascadeResult.ok) {
			ui.success(
				`Restacked ${cascadeResult.rebased} branches in "${depName}"`,
			);
			await cascadeDependentStacks(state, depName, cascade, visited);
		} else {
			return;
		}
	}
}
