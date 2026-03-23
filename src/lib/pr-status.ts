import { tryDaemonCache } from './daemon.js';
import * as gh from './gh.js';
import type { PrStatus, StackFile } from './types.js';

export async function fetchAllPrStatuses(
	state: StackFile,
): Promise<Map<number, PrStatus>> {
	const allPrNumbers: number[] = [];
	for (const stack of Object.values(state.stacks)) {
		for (const branch of stack.branches) {
			if (branch.pr != null) {
				allPrNumbers.push(branch.pr);
			}
		}
	}

	if (allPrNumbers.length === 0) return new Map();

	const fullName = state.repo || gh.repoFullName();
	const [owner, repoName] = fullName.split('/');
	let prStatuses =
		owner && repoName ? await tryDaemonCache(owner, repoName) : null;
	if (!prStatuses) {
		prStatuses = gh.prViewBatch(allPrNumbers);
	}
	return prStatuses;
}
