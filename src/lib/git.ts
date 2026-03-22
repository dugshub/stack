interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RebaseResult {
  ok: boolean;
  conflicts: string[];
}

function exec(...args: string[]): RunResult {
  const result = Bun.spawnSync(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

export function run(...args: string[]): string {
  const result = exec(...args);
  if (!result.ok) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

export function tryRun(...args: string[]): RunResult {
  return exec(...args);
}

export function currentBranch(): string {
  return run('branch', '--show-current');
}

export function revParse(ref: string, opts?: { cwd?: string }): string {
  if (opts?.cwd) {
    const result = Bun.spawnSync(['git', 'rev-parse', ref], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: opts.cwd,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git rev-parse ${ref} failed in ${opts.cwd}: ${result.stderr.toString()}`,
      );
    }
    return result.stdout.toString().trim();
  }
  return run('rev-parse', ref);
}

export function defaultBranch(): string {
  const result = tryRun('rev-parse', '--abbrev-ref', 'origin/HEAD');
  if (result.ok) {
    return result.stdout.replace('origin/', '');
  }
  // Fallback: check for common defaults
  const mainResult = tryRun('rev-parse', '--verify', 'refs/heads/main');
  if (mainResult.ok) return 'main';
  const masterResult = tryRun('rev-parse', '--verify', 'refs/heads/master');
  if (masterResult.ok) return 'master';
  return 'main';
}

/** Returns true if the branch needs to be pushed (local tip differs from remote tip). */
export function needsPush(branch: string): boolean {
  const localTip = tryRun('rev-parse', branch);
  if (!localTip.ok) return true;
  const remoteTip = tryRun('rev-parse', `origin/${branch}`);
  if (!remoteTip.ok) return true;
  return localTip.stdout !== remoteTip.stdout;
}

export function hasRemoteRef(branch: string): boolean {
  const result = tryRun('rev-parse', '--verify', `origin/${branch}`);
  return result.ok;
}

export function isAncestor(ancestor: string, descendant: string): boolean {
  const result = tryRun('merge-base', '--is-ancestor', ancestor, descendant);
  return result.ok;
}

export function rebaseOnto(
  newBase: string,
  oldBase: string,
  branch: string,
  opts?: { cwd?: string },
): RebaseResult {
  // --empty=drop: explicitly drop commits that become empty after squash-merge rebase
  const args = ['rebase', '--onto', newBase, '--empty=drop', oldBase, branch];
  if (opts?.cwd) {
    const result = Bun.spawnSync(['git', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: opts.cwd,
    });
    if (result.exitCode === 0) return { ok: true, conflicts: [] };
    const statusResult = Bun.spawnSync(['git', 'status', '--porcelain'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: opts.cwd,
    });
    const conflicts = statusResult.stdout
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('UU '))
      .map((line) => line.slice(3));
    return { ok: false, conflicts };
  }
  // existing non-worktree path
  const result = tryRun(...args);
  if (result.ok) {
    return { ok: true, conflicts: [] };
  }
  const statusResult = tryRun('status', '--porcelain');
  const conflicts = statusResult.stdout
    .split('\n')
    .filter((line) => line.startsWith('UU '))
    .map((line) => line.slice(3));
  return { ok: false, conflicts };
}

export function worktreeList(): Map<string, string> {
  const output = run('worktree', 'list', '--porcelain');
  const map = new Map<string, string>();
  let currentPath = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('branch refs/heads/')) {
      const branch = line.slice('branch refs/heads/'.length);
      map.set(branch, currentPath);
    }
  }
  return map;
}

/** Returns list of files changed between two refs (two-dot diff). */
export function diffFiles(base: string, head: string): string[] {
  const result = tryRun('diff', '--name-only', `${base}..${head}`);
  if (!result.ok) return [];
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

/** Returns list of files with uncommitted changes (staged + unstaged + new staged files). */
export function dirtyFiles(): string[] {
  // git diff HEAD catches all staged and unstaged changes to tracked files
  const diff = tryRun('diff', '--name-only', 'HEAD');
  const tracked = diff.ok
    ? diff.stdout.split('\n').filter((line) => line.length > 0)
    : [];
  // git diff --cached --diff-filter=A catches newly staged files not yet in HEAD
  const added = tryRun('diff', '--cached', '--diff-filter=A', '--name-only');
  const newFiles = added.ok
    ? added.stdout.split('\n').filter((line) => line.length > 0)
    : [];
  return [...new Set([...tracked, ...newFiles])];
}

export function isDirty(): boolean {
  // Only check tracked files — untracked files shouldn't block sync/rebase
  const result = run('status', '--porcelain', '-uno');
  return result.length > 0;
}

export function log(range: string, format?: string): string[] {
  const args = ['log', `--format=${format ?? '%H'}`, range];
  const output = tryRun(...args);
  if (!output.ok) return [];
  return output.stdout.split('\n').filter((line) => line.length > 0);
}

export function fetch(remote?: string): void {
  run('fetch', '--prune', remote ?? 'origin');
}

export function checkout(branch: string): void {
  run('checkout', branch);
}

export function createBranch(name: string): void {
  run('checkout', '-b', name);
}

export function pushForceWithLease(remote: string, branch: string): RunResult {
  return tryRun('push', '--force-with-lease', remote, branch);
}

export function pushNew(remote: string, branch: string): void {
  run('push', '-u', remote, branch);
}

export type PushPlan = {
  branch: string;
  mode: 'force-with-lease' | 'new';
};

export type PushResult = {
  branch: string;
  ok: boolean;
  error?: string;
};

/** Push multiple branches in parallel using async Bun.spawn. */
export async function pushParallel(remote: string, plans: PushPlan[]): Promise<PushResult[]> {
  const promises = plans.map(async (plan) => {
    const args = plan.mode === 'new'
      ? ['git', 'push', '-u', remote, plan.branch]
      : ['git', 'push', '--force-with-lease', remote, plan.branch];
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return {
      branch: plan.branch,
      ok: exitCode === 0,
      error: exitCode !== 0 ? stderr.trim() : undefined,
    };
  });
  return Promise.all(promises);
}

export function resetHard(branch: string, sha: string): void {
  run('checkout', branch);
  run('reset', '--hard', sha);
}

export function branchCreate(name: string, sha: string): boolean {
  return tryRun('branch', name, sha).ok;
}

export function deleteBranch(
  branch: string,
  opts?: { remote?: boolean },
): void {
  if (opts?.remote) {
    tryRun('push', 'origin', '--delete', branch);
  }
  tryRun('branch', '-d', branch);
}

export function repoBasename(): string {
  const root = run('rev-parse', '--show-toplevel');
  const parts = root.split('/');
  const name = parts[parts.length - 1];
  if (!name) {
    throw new Error('Could not determine repo basename');
  }
  return name;
}

export function repoRoot(): string {
  return run('rev-parse', '--show-toplevel');
}

/** Parse `git diff --numstat` output for staged+unstaged changes. */
export function diffNumstat(): Array<{ path: string; added: number; removed: number }> {
  const result = tryRun('diff', '--numstat', 'HEAD');
  if (!result.ok || result.stdout.length === 0) return [];
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('\t');
      return {
        added: parts[0] === '-' ? 0 : Number.parseInt(parts[0] ?? '0', 10),
        removed: parts[1] === '-' ? 0 : Number.parseInt(parts[1] ?? '0', 10),
        path: parts[2] ?? '',
      };
    })
    .filter((entry) => entry.path.length > 0);
}

export function stashPush(opts: { includeUntracked?: boolean; message?: string }): void {
  const args = ['stash', 'push'];
  if (opts.includeUntracked) args.push('-u');
  if (opts.message) args.push('-m', opts.message);
  run(...args);
}

export function stashPop(): void {
  run('stash', 'pop');
}

/** Find a stash by its message and drop it. */
export function stashDrop(message: string): void {
  const result = tryRun('stash', 'list');
  if (!result.ok || result.stdout.length === 0) return;
  const lines = result.stdout.split('\n');
  for (const line of lines) {
    if (line.includes(message)) {
      const match = line.match(/^(stash@\{\d+\})/);
      if (match?.[1]) {
        tryRun('stash', 'drop', match[1]);
        return;
      }
    }
  }
}

/**
 * Run a function with a clean worktree. Auto-stashes if dirty, restores
 * original branch and pops stash on completion.
 * Pass `skip: true` (e.g. from --no-stash) to reject dirty worktrees instead.
 */
export function withCleanWorktree<T>(fn: () => T, opts?: { skip?: boolean }): T {
  const dirty = isDirty();
  if (dirty && opts?.skip) {
    throw new Error('Working tree is dirty. Commit or stash changes first.');
  }
  const originalBranch = currentBranch();
  if (dirty) stashPush({ includeUntracked: true, message: 'stack-auto-stash' });
  try {
    return fn();
  } finally {
    const current = tryRun('branch', '--show-current');
    if (current.ok && current.stdout !== originalBranch) {
      tryRun('checkout', originalBranch);
    }
    if (dirty) {
      const pop = tryRun('stash', 'pop');
      if (!pop.ok) {
        process.stderr.write(
          `\x1b[33m⚠\x1b[0m Auto-stash pop failed — your changes are in \`git stash\`.\n`,
        );
      }
    }
  }
}

/** Async version of withCleanWorktree. */
export async function withCleanWorktreeAsync<T>(fn: () => Promise<T>, opts?: { skip?: boolean }): Promise<T> {
  const dirty = isDirty();
  if (dirty && opts?.skip) {
    throw new Error('Working tree is dirty. Commit or stash changes first.');
  }
  const originalBranch = currentBranch();
  if (dirty) stashPush({ includeUntracked: true, message: 'stack-auto-stash' });
  try {
    return await fn();
  } finally {
    const current = tryRun('branch', '--show-current');
    if (current.ok && current.stdout !== originalBranch) {
      tryRun('checkout', originalBranch);
    }
    if (dirty) {
      const pop = tryRun('stash', 'pop');
      if (!pop.ok) {
        process.stderr.write(
          `\x1b[33m⚠\x1b[0m Auto-stash pop failed — your changes are in \`git stash\`.\n`,
        );
      }
    }
  }
}

/** Reset working tree to match HEAD: discard modifications and remove untracked files. */
export function cleanWorkingTree(): void {
  tryRun('checkout', '--', '.');
  tryRun('clean', '-fd');
}

/** Returns all dirty files: modified, staged, and untracked (individual files). */
export function allDirtyFiles(): string[] {
  // -u shows individual untracked files (not just directories)
  // Don't use tryRun — its .trim() corrupts the leading space of porcelain output
  const result = Bun.spawnSync(['git', 'status', '--porcelain', '-u'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return [];
  const raw = result.stdout.toString();
  if (raw.trim().length === 0) return [];
  return raw
    .split('\n')
    .filter((line) => line.length >= 4) // XY + space + at least 1 char path
    .map((line) => {
      // Porcelain format: XY PATH where XY is 2-char status, then space, then path
      const path = line.slice(3);
      // Handle renames: "R  old -> new" — use only the new path
      if ((line[0] === 'R' || line[1] === 'R') && path.includes(' -> ')) {
        return path.split(' -> ').pop() ?? path;
      }
      return path;
    })
    .filter((path) => path.length > 0);
}

export function isRebaseInProgress(cwd?: string): boolean {
  const { existsSync } = require('fs');
  const gitPaths = ['rebase-merge', 'rebase-apply'];
  for (const p of gitPaths) {
    const result = cwd
      ? Bun.spawnSync(['git', 'rev-parse', '--git-path', p], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd,
        })
      : Bun.spawnSync(['git', 'rev-parse', '--git-path', p], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
    if (result.exitCode === 0 && existsSync(result.stdout.toString().trim())) {
      return true;
    }
  }
  return false;
}
