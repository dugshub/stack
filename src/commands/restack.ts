import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { findActiveStack, loadAndRefreshState, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { RestackState } from '../lib/types.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class RestackCommand extends Command {
	static override paths = [['restack']];

	static override usage = Command.Usage({
		description: 'Rebase downstream branches after amending a stack branch',
		examples: [
			['Restack downstream branches', 'stack restack'],
			['Continue after resolving conflicts', 'stack restack --continue'],
			['Abort in-progress restack', 'stack restack --abort'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	continue = Option.Boolean('--continue', false, {
		description: 'Continue restack after resolving conflicts',
	});

	abort = Option.Boolean('--abort', false, {
		description: 'Abort in-progress restack',
	});

	async execute(): Promise<number> {
		if (this.continue && this.abort) {
			ui.error('Cannot use --continue and --abort together');
			return 2;
		}

		if (this.continue) {
			return this.doContinue();
		}

		if (this.abort) {
			return this.doAbort();
		}

		return this.doRestack();
	}

	private async doRestack(): Promise<number> {
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
			ui.error('A restack is already in progress. Use --continue or --abort.');
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

		const currentIndex = fromIndex === -1 ? 0 : fromIndex + 1;

		// If restacking from bottom (fromIndex === -1), rebase first branch onto trunk
		if (fromIndex === -1 && stack.branches.length > 0) {
			const firstBranch = stack.branches[0];
			if (firstBranch) {
				const oldTip = oldTips[firstBranch.name];
				if (oldTip) {
					const mergeBaseResult = git.tryRun('merge-base', firstBranch.name, stack.trunk);
					const oldBase = mergeBaseResult.ok ? mergeBaseResult.stdout : oldTip;

					ui.info(`Rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}...`);
					const result = git.rebaseOnto(stack.trunk, oldBase, firstBranch.name);
					if (result.ok) {
						firstBranch.tip = git.revParse(firstBranch.name);
						oldTips[firstBranch.name] = firstBranch.tip;
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
							`Resolve conflicts, stage files, then run ${theme.command('stack restack --continue')}.`,
						);
						return 1;
					}
				}
			}
		}

		const restackState: RestackState = {
			fromIndex,
			currentIndex: fromIndex === -1 ? 1 : currentIndex,
			oldTips,
		};
		stack.restackState = restackState;
		saveState(state);

		// Build worktree map
		const worktreeMap = git.worktreeList();

		// Cascade rebase for each downstream branch
		return this.cascadeRebase(state, stack, resolvedName, worktreeMap);
	}

	private cascadeRebase(
		state: ReturnType<typeof loadState>,
		stack: NonNullable<ReturnType<typeof loadState>['stacks'][string]>,
		stackName: string,
		worktreeMap: Map<string, string>,
	): number {
		const restackState = stack.restackState;
		if (!restackState) return 0;

		for (let i = restackState.currentIndex; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch) continue;

			const parentBranch = stack.branches[i - 1];
			if (!parentBranch) continue;

			const oldTip = restackState.oldTips[parentBranch.name];
			if (!oldTip) {
				ui.warn(
					`No old tip recorded for "${parentBranch.name}" -- skipping rebase of "${branch.name}"`,
				);
				continue;
			}

			ui.info(`Rebasing ${theme.branch(branch.name)} onto ${theme.branch(parentBranch.name)}...`);

			// Determine execution directory for worktree-aware rebase
			const worktreePath = worktreeMap.get(branch.name);
			let rebaseResult: ReturnType<typeof git.rebaseOnto>;

			if (worktreePath) {
				// Execute from worktree directory
				const result = Bun.spawnSync(
					['git', 'rebase', '--onto', parentBranch.name, oldTip, branch.name],
					{ stdout: 'pipe', stderr: 'pipe', cwd: worktreePath },
				);
				if (result.exitCode === 0) {
					rebaseResult = { ok: true, conflicts: [] };
				} else {
					const statusResult = Bun.spawnSync(['git', 'status', '--porcelain'], {
						stdout: 'pipe',
						stderr: 'pipe',
						cwd: worktreePath,
					});
					const conflicts = statusResult.stdout
						.toString()
						.split('\n')
						.filter((line) => line.startsWith('UU '))
						.map((line) => line.slice(3));
					rebaseResult = { ok: false, conflicts };
				}
			} else {
				rebaseResult = git.rebaseOnto(parentBranch.name, oldTip, branch.name);
			}

			if (rebaseResult.ok) {
				// Update tip and advance -- use worktree cwd if branch is in a worktree
				branch.tip = git.revParse(branch.name, {
					cwd: worktreePath ?? undefined,
				});
				restackState.currentIndex = i + 1;
				// Record new tip as old tip for next iteration
				restackState.oldTips[branch.name] = branch.tip;
				saveState(state);
				ui.success(`Rebased ${theme.branch(branch.name)}`);
			} else {
				// Conflict -- save state and exit
				restackState.currentIndex = i;
				saveState(state);
				ui.error(`Conflict rebasing ${theme.branch(branch.name)}`);
				if (rebaseResult.conflicts.length > 0) {
					ui.info('Conflicting files:');
					for (const file of rebaseResult.conflicts) {
						ui.info(`  ${file}`);
					}
				}
				ui.info(
					`Resolve conflicts, stage files, then run ${theme.command('stack restack --continue')}.`,
				);
				return 1;
			}
		}

		// All done -- clear restackState
		stack.restackState = null;
		stack.updated = new Date().toISOString();
		saveState(state);

		ui.success(
			`Restacked ${stack.branches.length - (restackState.fromIndex === -1 ? 0 : restackState.fromIndex) - 1} branches in "${stackName}"`,
		);
		return 0;
	}

	private doContinue(): number {
		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		// Find stack with restackState -- may not be on a stack branch if in conflict
		let stackName: string | undefined;
		let stack:
			| NonNullable<ReturnType<typeof loadState>['stacks'][string]>
			| undefined;

		if (position) {
			stackName = position.stackName;
			stack = state.stacks[stackName];
		} else {
			// Search for a stack with restackState
			for (const [name, s] of Object.entries(state.stacks)) {
				if (s.restackState) {
					stackName = name;
					stack = s;
					break;
				}
			}
		}

		if (!stackName || !stack) {
			ui.error('No stack found with an in-progress restack');
			return 2;
		}

		if (!stack.restackState) {
			ui.error('No restack in progress');
			return 2;
		}

		const restackState = stack.restackState;
		const currentBranch = stack.branches[restackState.currentIndex];
		if (!currentBranch) {
			ui.error('Could not determine current restack branch');
			return 2;
		}

		// Determine execution directory
		const worktreeMap = git.worktreeList();
		const worktreePath = worktreeMap.get(currentBranch.name);

		// Run git rebase --continue
		let continueResult: { ok: boolean; exitCode: number };
		if (worktreePath) {
			const result = Bun.spawnSync(['git', 'rebase', '--continue'], {
				stdout: 'pipe',
				stderr: 'pipe',
				cwd: worktreePath,
				env: { ...process.env, GIT_EDITOR: 'true' },
			});
			continueResult = { ok: result.exitCode === 0, exitCode: result.exitCode };
		} else {
			const result = git.tryRun('rebase', '--continue');
			continueResult = { ok: result.ok, exitCode: result.exitCode };
		}

		if (!continueResult.ok) {
			// Check if a rebase is actually in progress -- if not, it was already
			// completed externally (e.g. user ran `git rebase --continue` directly)
			if (git.isRebaseInProgress(worktreePath ?? undefined)) {
				ui.error(
					'Rebase continue failed. There may still be unresolved conflicts.',
				);
				return 1;
			}

			// No rebase in progress -- it was completed outside of stack
			ui.info('Rebase already completed externally, updating stack state...');
		}

		// Update tip and advance -- use worktree cwd if branch is in a worktree
		currentBranch.tip = git.revParse(currentBranch.name, {
			cwd: worktreePath ?? undefined,
		});
		restackState.oldTips[currentBranch.name] = currentBranch.tip;
		restackState.currentIndex += 1;
		saveState(state);
		ui.success(`Rebased ${theme.branch(currentBranch.name)}`);

		// Continue cascade
		return this.cascadeRebase(state, stack, stackName, worktreeMap);
	}

	private doAbort(): number {
		const state = loadAndRefreshState();

		// Find stack with restackState
		let stackName: string | undefined;
		let stack:
			| NonNullable<ReturnType<typeof loadState>['stacks'][string]>
			| undefined;

		for (const [name, s] of Object.entries(state.stacks)) {
			if (s.restackState) {
				stackName = name;
				stack = s;
				break;
			}
		}

		if (!stackName || !stack || !stack.restackState) {
			ui.error('No restack in progress');
			return 2;
		}

		const restackState = stack.restackState;
		const currentBranch = stack.branches[restackState.currentIndex];

		// Determine execution directory
		const worktreeMap = git.worktreeList();
		const worktreePath = currentBranch
			? worktreeMap.get(currentBranch.name)
			: undefined;

		// Run git rebase --abort
		if (worktreePath) {
			Bun.spawnSync(['git', 'rebase', '--abort'], {
				stdout: 'pipe',
				stderr: 'pipe',
				cwd: worktreePath,
			});
		} else {
			git.tryRun('rebase', '--abort');
		}

		// Clear restackState
		const fromIndex = restackState.fromIndex;
		stack.restackState = null;
		saveState(state);

		ui.success('Restack aborted.');
		ui.info(
			`Branches after position ${fromIndex + 1} are in their pre-restack state.`,
		);
		return 0;
	}
}
