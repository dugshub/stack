/**
 * Stack checks — posts commit statuses on stack PRs:
 *
 * 1. `stack/rebase-status` — whether the branch is properly rebased on its parent.
 * 2. `stack/merge-ready`  — whether the PR is next in line to merge.
 *
 * When a push happens on a stack branch, we:
 * 1. Look up which stack it belongs to
 * 2. Find its parent branch
 * 3. Check if parent tip is an ancestor of this branch
 * 4. Post a commit status (success/failure) via gh API
 * 5. Update merge-ready status for all PRs in the stack
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureClone, fetchClone } from './clone.js';
import { ghAsync, gitAsync } from './spawn.js';
import type { WebhookEvent } from './types.js';

const CHECK_CONTEXT = 'stack/rebase-status';
const MERGE_READY_CONTEXT = 'stack/merge-ready';

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
	context: string = CHECK_CONTEXT,
): Promise<void> {
	await ghAsync(
		'api',
		`repos/${repo}/statuses/${sha}`,
		'-f', `state=${state}`,
		'-f', `context=${context}`,
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
	if (!state) {
		console.log(`Rebase check: no state for ${event.repo}`);
		return;
	}

	const position = findBranchInStack(state, event.branch);
	if (!position) {
		console.log(`Rebase check: ${event.branch} not in any stack`);
		return;
	}

	console.log(`Rebase check: ${event.branch} (parent: ${position.parentBranch})`);

	// Post pending status immediately
	await postCommitStatus(
		event.repo,
		event.headSha,
		'pending',
		'Checking rebase status...',
	);

	// Ensure bare clone exists and fetch latest (retry with fresh clone on failure)
	const repoUrl = `https://github.com/${event.repo}.git`;
	let clonePath = await ensureClone(repoUrl, repoName);
	try {
		await fetchClone(clonePath);
	} catch {
		console.log(`Rebase check: fetch failed, re-cloning ${repoName}`);
		const { rmSync } = await import('node:fs');
		rmSync(clonePath, { recursive: true, force: true });
		clonePath = await ensureClone(repoUrl, repoName);
		await fetchClone(clonePath);
	}

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
		console.log(`Rebase check: ${event.branch} ✓ rebased on ${position.parentBranch}`);
		await postCommitStatus(
			event.repo,
			event.headSha,
			'success',
			`Rebased on ${position.parentBranch}`,
		);
	} else {
		console.log(`Rebase check: ${event.branch} ✗ NOT rebased on ${position.parentBranch} (stderr: ${result.stderr})`);
		await postCommitStatus(
			event.repo,
			event.headSha,
			'failure',
			`Needs restack — not rebased on ${position.parentBranch}`,
		);
	}

	// Also update merge-ready status for all PRs in this stack
	const knownSHAs = new Map([[event.branch, event.headSha]]);
	await updateMergeReadyStatus(event.repo, state, position.stackName, clonePath, knownSHAs);
}

/** Batch-query GitHub to find which PR numbers are still open. */
async function getOpenPRNumbers(repo: string, prNumbers: number[]): Promise<Set<number>> {
	const [owner, name] = repo.split('/');
	const result = await ghAsync(
		'api', 'graphql',
		'-f', `query=query {
			repository(owner: "${owner}", name: "${name}") {
				${prNumbers.map((n, i) => `pr${i}: pullRequest(number: ${n}) { number state }`).join('\n')}
			}
		}`,
	);
	if (!result.ok) return new Set(prNumbers); // assume all open on failure

	const data = JSON.parse(result.stdout) as {
		data: { repository: Record<string, { number: number; state: string }> }
	};

	const open = new Set<number>();
	for (const pr of Object.values(data.data.repository)) {
		if (pr && pr.state === 'OPEN') open.add(pr.number);
	}
	return open;
}

/**
 * Update the `stack/merge-ready` commit status on every open PR in a stack.
 * The bottom-most unmerged PR gets "success"; all others get "failure".
 */
async function updateMergeReadyStatus(
	repo: string,
	state: StackFile,
	stackName: string,
	clonePath: string,
	/** SHA overrides keyed by branch name — use for the just-pushed branch */
	knownSHAs?: Map<string, string>,
): Promise<void> {
	const stack = state.stacks[stackName];
	if (!stack) return;

	// Find branches that have PRs
	const branchesWithPRs = stack.branches.filter(b => b.pr != null);
	if (branchesWithPRs.length === 0) return;

	// Get open PR numbers for this stack
	const openPRs = await getOpenPRNumbers(repo, branchesWithPRs.map(b => b.pr as number));

	// Find the first branch whose PR is still open — that's the merge-ready one
	let firstUnmergedIndex = -1;
	for (let i = 0; i < stack.branches.length; i++) {
		const branch = stack.branches[i];
		if (branch?.pr != null && openPRs.has(branch.pr)) {
			firstUnmergedIndex = i;
			break;
		}
	}

	// Post status on each open PR branch
	for (let i = 0; i < stack.branches.length; i++) {
		const branch = stack.branches[i];
		if (!branch?.pr) continue;
		if (!openPRs.has(branch.pr)) continue; // skip merged PRs

		// Resolve current HEAD — use override if available, otherwise rev-parse from bare clone
		const sha = knownSHAs?.get(branch.name)
			?? (await gitAsync(['rev-parse', branch.name], { cwd: clonePath })).stdout?.trim();
		if (!sha) continue;

		if (i === firstUnmergedIndex) {
			await postCommitStatus(repo, sha, 'success',
				'Ready to merge (next in stack)', MERGE_READY_CONTEXT);
		} else {
			const blockingPR = stack.branches[firstUnmergedIndex]?.pr;
			await postCommitStatus(repo, sha, 'failure',
				`Waiting for PR #${blockingPR} to merge first`, MERGE_READY_CONTEXT);
		}
	}
}

/**
 * Handle a PR merge event that occurred outside an active merge job.
 * Re-evaluates merge-ready status for remaining PRs in the stack.
 */
export async function handlePRMergedEvent(
	event: Extract<WebhookEvent, { type: 'pr_merged' }>,
): Promise<void> {
	const state = loadStackStateForRepo(event.repo);
	if (!state) return;

	// Find which stack this PR belongs to
	for (const [stackName, stack] of Object.entries(state.stacks)) {
		const branch = stack.branches.find(b => b.pr === event.prNumber);
		if (branch) {
			console.log(`Merge-ready: PR #${event.prNumber} merged, updating stack "${stackName}"`);
			// Fetch bare clone to get current branch HEADs
			const repoName = event.repo.replace('/', '-');
			const repoUrl = `https://github.com/${event.repo}.git`;
			const clonePath = await ensureClone(repoUrl, repoName);
			await fetchClone(clonePath);
			await updateMergeReadyStatus(event.repo, state, stackName, clonePath);
			break;
		}
	}
}
