import * as clone from './clone.js';
import { ghAsync, gitAsync } from './spawn.js';
import type { EngineAction, MergeStrategy } from './types.js';

export interface ActionResult {
	action: EngineAction;
	ok: boolean;
	error?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function strategyFlag(strategy: MergeStrategy): string {
	return strategy === 'squash'
		? '--squash'
		: strategy === 'rebase'
			? '--rebase'
			: '--merge';
}

async function executeOne(
	action: EngineAction,
	config: { clonePath: string },
): Promise<ActionResult> {
	switch (action.type) {
		case 'enable-auto-merge': {
			// Retry up to 2 additional attempts with 3s backoff
			let lastError: string | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				if (attempt > 0) {
					await sleep(3000);
				}
				const result = await ghAsync(
					'pr',
					'merge',
					String(action.prNumber),
					'--auto',
					strategyFlag(action.strategy),
				);
				if (result.ok) {
					return { action, ok: true };
				}
				lastError = result.stderr;
			}
			return { action, ok: false, error: lastError };
		}

		case 'rebase-and-push': {
			await clone.fetchClone(config.clonePath);
			const rebaseResult = await clone.rebaseInWorktree(config.clonePath, {
				branch: action.branch,
				onto: action.onto,
				oldBase: action.oldBase,
			});
			if (!rebaseResult.ok) {
				return { action, ok: false, error: rebaseResult.error };
			}
			const pushResult = await clone.pushBranch(
				config.clonePath,
				action.branch,
			);
			if (!pushResult.ok) {
				return { action, ok: false, error: pushResult.error };
			}
			return { action, ok: true };
		}

		case 'retarget-pr': {
			const result = await ghAsync(
				'pr',
				'edit',
				String(action.prNumber),
				'--base',
				action.newBase,
			);
			if (!result.ok) {
				return { action, ok: false, error: result.stderr };
			}
			return { action, ok: true };
		}

		case 'delete-branches': {
			const errors: string[] = [];
			for (const branch of action.branches) {
				if (branch.remote) {
					const result = await gitAsync([
						'push',
						'origin',
						'--delete',
						branch.name,
					]);
					if (!result.ok) {
						errors.push(
							`Failed to delete remote ${branch.name}: ${result.stderr}`,
						);
					}
				}
			}
			if (errors.length > 0) {
				return { action, ok: false, error: errors.join('; ') };
			}
			return { action, ok: true };
		}

		case 'notify': {
			// Notify actions are informational; logging happens at the server level
			return { action, ok: true };
		}
	}
}

export async function executeActions(
	actions: EngineAction[],
	config: { clonePath: string },
): Promise<ActionResult[]> {
	const results: ActionResult[] = [];
	for (const action of actions) {
		const result = await executeOne(action, config);
		results.push(result);
		// Short-circuit on failure — later actions depend on earlier ones
		// (e.g. retarget depends on rebase succeeding)
		if (!result.ok && action.type !== 'notify' && action.type !== 'delete-branches') {
			break;
		}
	}
	return results;
}

// Actions execute side effects from engine decisions
