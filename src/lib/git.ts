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
): RebaseResult {
  const result = tryRun('rebase', '--onto', newBase, oldBase, branch);
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
  run('fetch', remote ?? 'origin');
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
