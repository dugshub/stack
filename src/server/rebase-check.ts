/**
 * Rebase status check — posts a commit status on stack PRs indicating
 * whether the branch is properly rebased on its parent.
 *
 * When a push happens on a stack branch, we:
 * 1. Look up which stack it belongs to
 * 2. Find its parent branch
 * 3. Check if parent tip is an ancestor of this branch
 * 4. Post a commit status (success/failure) via gh API
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureClone, fetchClone } from './clone.js';
import { ghAsync, gitAsync } from './spawn.js';
import type { WebhookEvent } from './types.js';

const CHECK_CONTEXT = 'stack/rebase-status';

interface StackFile {
	repo: string;
	stacks: Record<
		string,
		{
			trunk: string;
			branches: Array<{ name: string; pr: number | null; tip: string | null }>;
		}
	>;
}

interface BranchPosition {
	stackName: string;
	index: number;
	parentBranch: string; // trunk or the branch below
}

/** Find the stack state file for a given repo (e.g. "owner/repo").
 *  Scans all state files and matches on the `repo` field, which is the
 *  canonical full name stored by the CLI. */
function loadStackStateForRepo(fullRepoName: string): StackFile | null {
	const stacksDir = join(homedir(), '.claude', 'stacks');
	let files: string[];
	try {
		files = readdirSync(stacksDir);
	} catch {
		return null;
	}
	for (const file of files) {
		if (!file.endsWith('.json') || file === 'merge-jobs.json' || file === 'server.config.json') continue;
		try {
			const text = readFileSync(join(stacksDir, file), 'utf-8');
			const state = JSON.parse(text) as StackFile;
			if (state.repo === fullRepoName) {
				return state;
			}
		} catch {
			continue;
		}
	}
	return null;
}

function findBranchInStack(
	state: StackFile,
	branchName: string,
): BranchPosition | null {
	for (const [stackName, stack] of Object.entries(state.stacks)) {
		for (let i = 0; i < stack.branches.length; i++) {
			if (stack.branches[i]?.name === branchName) {
				const parentBranch =
					i === 0
						? stack.trunk
						: (stack.branches[i - 1]?.name ?? stack.trunk);
				return { stackName, index: i, parentBranch };
			}
		}
	}
	return null;
}

async function postCommitStatus(
	repo: string,
	sha: string,
	state: 'success' | 'failure' | 'pending',
	description: string,
): Promise<void> {
	await ghAsync(
		'api',
		`repos/${repo}/statuses/${sha}`,
		'-f', `state=${state}`,
		'-f', `context=${CHECK_CONTEXT}`,
		'-f', `description=${description}`,
	);
}

/**
 * Handle a push event — check if the pushed branch is properly rebased
 * on its parent in the stack and post a commit status.
 */
export async function handlePushEvent(
	event: Extract<WebhookEvent, { type: 'push' }>,
): Promise<void> {
	const repoName = event.repo.replace('/', '-');

	const state = loadStackStateForRepo(event.repo);
	if (!state) return;

	const position = findBranchInStack(state, event.branch);
	if (!position) return; // Not a stack branch — ignore

	// Post pending status immediately
	await postCommitStatus(
		event.repo,
		event.headSha,
		'pending',
		'Checking rebase status...',
	);

	// Ensure bare clone exists and fetch latest
	const repoUrl = `https://github.com/${event.repo}.git`;
	const clonePath = await ensureClone(repoUrl, repoName);
	await fetchClone(clonePath);

	// Check: is the parent branch tip an ancestor of this branch?
	// In a bare clone, branches are local refs (no origin/ prefix)
	const result = await gitAsync(
		[
			'merge-base',
			'--is-ancestor',
			position.parentBranch,
			event.branch,
		],
		{ cwd: clonePath },
	);

	if (result.ok) {
		await postCommitStatus(
			event.repo,
			event.headSha,
			'success',
			`Rebased on ${position.parentBranch}`,
		);
	} else {
		await postCommitStatus(
			event.repo,
			event.headSha,
			'failure',
			`Needs restack — not rebased on ${position.parentBranch}`,
		);
	}
}
