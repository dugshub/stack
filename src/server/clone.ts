import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execAsync } from './spawn.js';

function getClonesDir(): string {
	return join(homedir(), '.claude', 'stacks', 'clones');
}

export async function ensureClone(
	repoUrl: string,
	repoName: string,
): Promise<string> {
	const clonesDir = getClonesDir();
	mkdirSync(clonesDir, { recursive: true });
	const clonePath = join(clonesDir, `${repoName}.git`);

	if (existsSync(clonePath)) {
		return clonePath;
	}

	const result = await execAsync([
		'git',
		'clone',
		'--bare',
		repoUrl,
		clonePath,
	]);
	if (!result.ok) {
		throw new Error(`Failed to create bare clone: ${result.stderr}`);
	}

	// Bare clones don't set a fetch refspec — add one so fetch gets all branches
	await execAsync(
		['git', 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
		{ cwd: clonePath },
	);

	return clonePath;
}

export async function fetchClone(clonePath: string): Promise<void> {
	const result = await execAsync(['git', 'fetch', 'origin'], {
		cwd: clonePath,
	});
	if (!result.ok) {
		throw new Error(`Failed to fetch in bare clone: ${result.stderr}`);
	}
}

export async function rebaseInWorktree(
	clonePath: string,
	opts: { branch: string; onto: string; oldBase: string },
): Promise<{ ok: boolean; error?: string }> {
	const worktreePath = join(
		clonePath,
		'..',
		`worktree-${opts.branch.replace(/\//g, '-')}-${Date.now()}`,
	);

	try {
		// Create a temporary worktree for the branch
		const addResult = await execAsync(
			['git', 'worktree', 'add', worktreePath, opts.branch],
			{ cwd: clonePath },
		);
		if (!addResult.ok) {
			return { ok: false, error: `Failed to create worktree: ${addResult.stderr}` };
		}

		// Run rebase in the worktree
		const rebaseResult = await execAsync(
			['git', 'rebase', '--onto', opts.onto, opts.oldBase, opts.branch],
			{ cwd: worktreePath },
		);
		if (!rebaseResult.ok) {
			// Abort the rebase if it failed
			await execAsync(['git', 'rebase', '--abort'], { cwd: worktreePath });
			return {
				ok: false,
				error: `Rebase failed: ${rebaseResult.stderr}`,
			};
		}

		return { ok: true };
	} finally {
		// Clean up worktree
		await execAsync(['git', 'worktree', 'remove', '--force', worktreePath], {
			cwd: clonePath,
		});
		// Remove directory if it still exists
		if (existsSync(worktreePath)) {
			rmSync(worktreePath, { recursive: true, force: true });
		}
	}
}

export async function getBranchSha(
	clonePath: string,
	branch: string,
): Promise<string> {
	const result = await execAsync(
		['git', 'rev-parse', `refs/heads/${branch}`],
		{ cwd: clonePath },
	);
	if (!result.ok) {
		throw new Error(`Failed to resolve ${branch}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

export async function pushBranch(
	clonePath: string,
	branch: string,
	expectedSha?: string,
): Promise<{ ok: boolean; error?: string }> {
	const leaseFlag = expectedSha
		? `--force-with-lease=${branch}:${expectedSha}`
		: '--force-with-lease';
	const result = await execAsync(
		['git', 'push', leaseFlag, 'origin', branch],
		{ cwd: clonePath },
	);
	if (!result.ok) {
		return { ok: false, error: `Push failed: ${result.stderr}` };
	}
	return { ok: true };
}
