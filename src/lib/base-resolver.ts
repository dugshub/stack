import * as git from './git.js';
import type { StackFile, StackParent } from './types.js';

export interface ResolveBaseOpts {
	state: StackFile;
	/** Raw --base value, or undefined. */
	base: string | undefined;
	/** Additional parent branches (create's --also-base). Not passed by `base`. */
	alsoBase?: string[];
	/**
	 * When set, reject if the resolved primary parent's stack equals this name
	 * (can't re-parent onto a branch in the same stack). Passed by `base`;
	 * `create` omits it because the stack doesn't exist yet.
	 */
	selfStackName?: string;
}

export interface ResolveBaseResult {
	trunk?: string;
	baseTip?: string;
	/** Primary parent (if --base resolved inside a tracked stack). */
	primary?: StackParent;
	/** Secondary parents from --also-base. */
	secondaries?: StackParent[];
	/** Resolved branch names for --also-base (same order). */
	secondaryBranches?: string[];
	error?: string;
}

/**
 * Resolve a `--base` value (and optional `--also-base` list) to a trunk
 * branch plus optional dependency links. Shared by `st create` and
 * `st stack base`.
 *
 * - `.` resolves to the current branch.
 * - The base branch must exist in git (`rev-parse --verify`).
 * - If the base branch is tracked inside another stack, that stack becomes
 *   the primary parent (`dependsOn`).
 * - When `selfStackName` is set, rejects if the resolved primary parent's
 *   stack equals that name.
 */
export function resolveBase(opts: ResolveBaseOpts): ResolveBaseResult {
	const { state, base, alsoBase, selfStackName } = opts;

	if (!base) {
		if (alsoBase && alsoBase.length > 0) {
			return { error: '--also-base requires --base' };
		}
		return {};
	}

	// Resolve "." to current branch
	const baseBranch = base === '.' ? git.currentBranch() : base;

	// Validate base branch exists
	const verifyResult = git.tryRun('rev-parse', '--verify', baseBranch);
	if (!verifyResult.ok) {
		return { error: `Base branch "${baseBranch}" does not exist` };
	}

	const baseTip = git.revParse(baseBranch);

	// Scan all stacks to find which stack owns a given branch
	const findOwner = (branchName: string): StackParent | undefined => {
		for (const [stackName, stack] of Object.entries(state.stacks)) {
			for (const branch of stack.branches) {
				if (branch.name === branchName) {
					return { stack: stackName, branch: branchName };
				}
			}
		}
		return undefined;
	};

	const primary = findOwner(baseBranch);

	// Self-reference check: reject if primary is owned by the target stack.
	if (selfStackName && primary && primary.stack === selfStackName) {
		return {
			error: `Cannot re-parent onto a branch in the same stack ("${selfStackName}")`,
		};
	}

	// Resolve secondaries from --also-base
	const secondaries: StackParent[] = [];
	const secondaryBranches: string[] = [];
	for (const raw of alsoBase ?? []) {
		const name = raw === '.' ? git.currentBranch() : raw;
		const verify = git.tryRun('rev-parse', '--verify', name);
		if (!verify.ok) {
			return { error: `Also-base branch "${name}" does not exist` };
		}
		const owner = findOwner(name);
		if (!owner) {
			return {
				error: `Also-base branch "${name}" is not tracked in any stack`,
			};
		}
		secondaries.push(owner);
		secondaryBranches.push(name);
	}

	return {
		trunk: baseBranch,
		baseTip,
		primary,
		secondaries,
		secondaryBranches,
	};
}
