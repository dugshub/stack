import * as git from './git.js';
import { saveState } from './state.js';
import { theme } from './theme.js';
import type { Branch, RestackState, Stack, StackFile } from './types.js';
import * as ui from './ui.js';

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
	// if the user rebased outside of `stack restack` (e.g. `git rebase origin/main`).
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
				`Resolve conflicts, stage files, then run ${theme.command('stack restack --continue')}.`,
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
