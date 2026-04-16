import { Command, Option } from 'clipanion';
import { collectNeighborChain, generateComment, type NeighborContext } from '../lib/comment.js';
import { tryDaemonCache } from '../lib/daemon.js';
import * as gh from '../lib/gh.js';
import { resolveStack } from '../lib/resolve.js';
import { findDependentStacks, loadAndRefreshState, primaryParent } from '../lib/state.js';
import type { PrStatus } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class CommentCommand extends Command {
	static override paths = [['stack', 'comment'], ['comment']];

	static override usage = Command.Usage({
		description: 'Preview stack navigation comment markdown',
		examples: [
			['Preview comment for current branch', 'st comment'],
			['Preview comments for all branches', 'st comment --all'],
			['Preview for a specific stack', 'st comment --stack my-stack'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	all = Option.Boolean('--all', false, {
		description: 'Preview comments for all branches in the stack',
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

		const { stackName, stack, position } = resolved;
		const repoUrl = `https://github.com/${state.repo}`;

		// Determine target branches
		const targetBranches = this.all
			? stack.branches
			: position
				? [stack.branches[position.index]!]
				: [stack.branches[0]!];

		// Check that target branches have PRs
		const branchesWithPr = targetBranches.filter((b) => b.pr != null);
		if (branchesWithPr.length === 0) {
			ui.warn('No PRs found for the target branch(es). Run `st submit` first to create PRs.');
			return 1;
		}

		// Phase 1: Collect PR numbers from current stack
		const prNumbers = stack.branches
			.map((b) => b.pr)
			.filter((pr): pr is number => pr != null);

		// Fetch PR statuses via daemon cache, fall back to gh API
		const fullName = state.repo || gh.repoFullName();
		const [owner, repoName] = fullName.split('/');
		let prStatuses = owner && repoName
			? await tryDaemonCache(owner, repoName)
			: null;
		if (!prStatuses) {
			prStatuses = gh.prViewBatch(prNumbers);
		}

		// Phase 2: Gather neighbor stack PRs (mirrors submit.ts lines 406-448)
		const commentDepth = state.config?.commentDepth ?? 3;
		const neighborPrNumbers: number[] = [];
		{
			const visited = new Set<string>([stackName]);
			// Walk upstream
			let walkName = stackName;
			for (let level = 0; level < commentDepth; level++) {
				const walkStack = state.stacks[walkName];
				if (!walkStack) break;
				const parent = primaryParent(walkStack);
				if (!parent || visited.has(parent.stack)) break;
				visited.add(parent.stack);
				const parentStack = state.stacks[parent.stack];
				if (!parentStack) break;
				for (const b of parentStack.branches) {
					if (b.pr != null) neighborPrNumbers.push(b.pr);
				}
				walkName = parent.stack;
			}
			// Walk downstream via BFS
			let queue = [stackName];
			for (let level = 0; level < commentDepth; level++) {
				const nextQueue: string[] = [];
				for (const name of queue) {
					const dependents = findDependentStacks(state, name);
					for (const dep of dependents) {
						if (visited.has(dep.name)) continue;
						visited.add(dep.name);
						for (const b of dep.stack.branches) {
							if (b.pr != null) neighborPrNumbers.push(b.pr);
						}
						nextQueue.push(dep.name);
					}
				}
				if (nextQueue.length === 0) break;
				queue = nextQueue;
			}
		}

		// Fetch neighbor PR statuses and merge into prStatuses
		const neighborStatuses = neighborPrNumbers.length > 0
			? gh.prViewBatch(neighborPrNumbers)
			: new Map<number, PrStatus>();
		for (const [num, status] of neighborStatuses) {
			prStatuses.set(num, status);
		}

		// Build neighbor context
		const chainResult = collectNeighborChain(state, stackName, prStatuses, commentDepth, repoUrl);
		const neighborCtx: NeighborContext = {
			neighbors: [...chainResult.downstream, ...chainResult.upstream],
			rootTrunk: chainResult.rootTrunk,
		};

		// Generate and output comments
		let first = true;
		for (const branch of targetBranches) {
			if (branch.pr == null) continue;

			if (this.all && !first) {
				process.stderr.write(`\n--- ${branch.name} (PR #${branch.pr}) ---\n\n`);
			} else if (this.all && first) {
				process.stderr.write(`--- ${branch.name} (PR #${branch.pr}) ---\n\n`);
			}

			const comment = generateComment(stack, branch.pr, prStatuses, repoUrl, neighborCtx);
			process.stdout.write(`${comment}\n`);
			first = false;
		}

		return 0;
	}
}
