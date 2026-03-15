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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureClone, fetchClone } from './clone.js';
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

async function ghAsync(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['gh', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitAsync(
	args: string[],
	opts?: { cwd?: string },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['git', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: opts?.cwd,
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

function loadStackState(repoName: string): StackFile | null {
	const filePath = join(homedir(), '.claude', 'stacks', `${repoName}.json`);
	try {
		const text = readFileSync(filePath, 'utf-8');
		return JSON.parse(text) as StackFile;
	} catch {
		return null;
	}
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
	await ghAsync([
		'api',
		`repos/${repo}/statuses/${sha}`,
		'-f', `state=${state}`,
		'-f', `context=${CHECK_CONTEXT}`,
		'-f', `description=${description}`,
	]);
}

/**
 * Handle a push event — check if the pushed branch is properly rebased
 * on its parent in the stack and post a commit status.
 */
export async function handlePushEvent(
	event: Extract<WebhookEvent, { type: 'push' }>,
): Promise<void> {
	// Derive repo name for state lookup (owner-repo format used by clone.ts)
	const repoName = event.repo.replace('/', '-');
	// State files use just the repo basename
	const stateRepoName = event.repo.split('/')[1];
	if (!stateRepoName) return;

	const state = loadStackState(stateRepoName);
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
	const result = await gitAsync(
		[
			'merge-base',
			'--is-ancestor',
			`origin/${position.parentBranch}`,
			`origin/${event.branch}`,
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
