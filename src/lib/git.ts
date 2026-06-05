import { basename, dirname, resolve } from 'node:path';

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

/**
 * `git cherry <upstream> <head>` classifies each commit in `<head>` that is not
 * in `<upstream>`: `+ <sha>` when no patch-equivalent commit exists upstream,
 * `- <sha>` when an equivalent one does. Merge commits have no patch-id and are
 * skipped by cherry entirely.
 *
 * IMPORTANT: only meaningful when `<head>` is NOT an ancestor of `<upstream>`
 * (i.e. the case-2 fast-forward check has already failed). On a pure
 * fast-forward cherry's empty output is ambiguous, so callers MUST run the
 * ancestry check first and treat empty output here as "diverged with no unique
 * local patches" only in the genuinely-diverged case.
 *
 * A failed run / non-zero exit yields an empty array; callers fail safe by
 * treating that as `diverged`.
 */
export function cherry(
  upstream: string,
  head: string,
): { sha: string; equivalent: boolean }[] {
  const result = tryRun('cherry', upstream, head);
  if (!result.ok || result.stdout.length === 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const equivalent = line.startsWith('-');
      const sha = line.replace(/^[+-]\s*/, '');
      return { sha, equivalent };
    });
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

/**
 * Best-effort fast-forward a LOCAL branch ref to `target` (e.g. `origin/main`)
 * WITHOUT checking it out. Purely a convenience so a later plain
 * `git checkout <branch>` shows the user an up-to-date trunk — sync rebases onto
 * the remote-tracking ref directly, so this never gates correctness.
 *
 * Fully non-fatal. No-op when:
 * - `target` can't be resolved,
 * - the branch is already at `target`,
 * - `target` is not a strict descendant of the branch (diverged/behind — never
 *   rewind or clobber local-only trunk commits),
 * - the branch is checked out in some worktree (`git branch -f` refuses — safe).
 *
 * Creates the branch at `target` if it doesn't exist yet. Safe to call from a
 * linked worktree.
 */
export function fastForwardLocalBranch(branch: string, target: string): void {
  const tgt = tryRun('rev-parse', '--verify', `${target}^{commit}`);
  if (!tgt.ok) return;
  const local = tryRun('rev-parse', '--verify', `refs/heads/${branch}`);
  if (!local.ok) {
    // No local branch yet — point it at the remote tip.
    tryRun('branch', branch, target);
    return;
  }
  if (local.stdout === tgt.stdout) return; // already current
  if (!isAncestor(local.stdout, tgt.stdout)) return; // not a fast-forward — leave it alone
  // `-f` refuses if the branch is checked out in any worktree → safe no-op there.
  tryRun('branch', '-f', branch, target);
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

/**
 * Stable per-repo key for stack state. Derived from the *shared* object store
 * (`--git-common-dir`), not the working-tree path, so every worktree of one repo
 * resolves to the same key — worktrees share refs and objects, so their stack
 * state is one coherent thing. `--git-common-dir` points at the main repo's
 * `.git` from any worktree; its parent directory is the repo root.
 *
 * For the main checkout this equals the old `basename(--show-toplevel)`, so
 * existing state files keep their names. Separate clones have distinct common
 * dirs and so stay isolated (their SHAs aren't valid in each other's stores).
 */
export function repoKey(): string {
  let commonDir: string;
  const abs = tryRun('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (abs.ok && abs.stdout.length > 0) {
    commonDir = abs.stdout;
  } else {
    // Fallback for git < 2.31 (no --path-format): resolve the possibly-relative
    // path against the current directory.
    commonDir = resolve(process.cwd(), run('rev-parse', '--git-common-dir'));
  }
  const name = basename(dirname(commonDir));
  if (!name) {
    throw new Error('Could not determine repo key');
  }
  return name;
}

export function repoRoot(): string {
  return run('rev-parse', '--show-toplevel');
}

/**
 * Best-effort `owner/repo` slug parsed from the `origin` remote URL, matching
 * the `nameWithOwner` format stored in `StackFile.repo`. Offline (no `gh` call).
 * Returns null if there's no origin or the URL can't be parsed.
 */
export function originSlug(): string | null {
  const r = tryRun('remote', 'get-url', 'origin');
  if (!r.ok || r.stdout.length === 0) return null;
  const url = r.stdout
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@[^:]+:/, '') // ssh: git@host:owner/repo
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//, ''); // https://host/owner/repo
  const parts = url.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
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
export async function withCleanWorktreeAsync<T>(fn: () => Promise<T>, opts?: { skip?: boolean; noRestore?: boolean }): Promise<T> {
  const dirty = isDirty();
  if (dirty && opts?.skip) {
    throw new Error('Working tree is dirty. Commit or stash changes first.');
  }
  const originalBranch = currentBranch();
  if (dirty) stashPush({ includeUntracked: true, message: 'stack-auto-stash' });
  try {
    return await fn();
  } finally {
    if (!opts?.noRestore) {
      const current = tryRun('branch', '--show-current');
      if (current.ok && current.stdout !== originalBranch) {
        tryRun('checkout', originalBranch);
      }
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
