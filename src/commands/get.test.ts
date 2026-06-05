import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { StackFile } from '../lib/types.js';

// ── Helpers ────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function runGet(cwd: string, ...extraArgs: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const cliPath = join(import.meta.dir, '..', 'cli.ts');
  const result = Bun.spawnSync(['bun', 'run', cliPath, 'get', ...extraArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function runSync(cwd: string, ...extraArgs: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const cliPath = join(import.meta.dir, '..', 'cli.ts');
  const result = Bun.spawnSync(['bun', 'run', cliPath, 'sync', ...extraArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function writeFile(cwd: string, filePath: string, content: string): void {
  const dir = join(cwd, filePath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, filePath), content, 'utf-8');
}

/**
 * The state key is `basename(dirname(git-common-dir))`. For a normal clone whose
 * `.git` lives directly under the working-tree dir, that equals the clone
 * directory name. Compute it the same way the CLI does to be robust.
 */
function repoKeyFor(cwd: string): string {
  const commonDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return basename(dirname(commonDir));
}

function stateFilePath(repoKey: string): string {
  return join(homedir(), '.claude', 'stacks', `${repoKey}.json`);
}

function writeStateFor(cwd: string, state: StackFile): string {
  const key = repoKeyFor(cwd);
  const dir = join(homedir(), '.claude', 'stacks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFilePath(key), JSON.stringify(state, null, 2), 'utf-8');
  return key;
}

function readStateFor(key: string): StackFile {
  return JSON.parse(readFileSync(stateFilePath(key), 'utf-8'));
}

function sha(cwd: string, ref: string): string {
  return git(cwd, 'rev-parse', ref);
}

function isAncestor(cwd: string, a: string, b: string): boolean {
  const r = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', a, b], { cwd });
  return r.exitCode === 0;
}

// ── Fixture ────────────────────────────────────────────────

interface Fixture {
  origin: string;
  local: string; // stale clone — CLI runs here
  daemon: string; // "daemon" clone that rewrites + force-pushes
  key: string;
  cleanup: string[];
}

const BRANCHES = ['user/feat/1-a', 'user/feat/2-b', 'user/feat/3-c'];

/**
 * Bare origin + a working clone with a 3-branch stack pushed + a second
 * "daemon" clone. Returns on branch 3 in the local clone.
 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'stack-get-test-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const local = join(root, 'local');
  const daemon = join(root, 'daemon');

  git(root, 'init', '--bare', '-b', 'main', origin);

  // Seed: initial commit on main + 3 stack branches.
  git(root, 'clone', origin, seed);
  git(seed, 'config', 'user.email', 'test@test.com');
  git(seed, 'config', 'user.name', 'Test');
  writeFile(seed, 'README.md', '# Test\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', 'origin', 'main');

  for (let i = 0; i < BRANCHES.length; i++) {
    git(seed, 'checkout', '-b', BRANCHES[i]!);
    writeFile(seed, `f${i + 1}.ts`, `export const v${i + 1} = 1;\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', `add f${i + 1}`);
    git(seed, 'push', 'origin', BRANCHES[i]!);
  }

  // Local clone (the stale one).
  git(root, 'clone', origin, local);
  git(local, 'config', 'user.email', 'test@test.com');
  git(local, 'config', 'user.name', 'Test');
  for (const b of BRANCHES) {
    git(local, 'checkout', '-B', b, `origin/${b}`);
  }
  git(local, 'checkout', BRANCHES[2]!);

  // Daemon clone.
  git(root, 'clone', origin, daemon);
  git(daemon, 'config', 'user.email', 'daemon@test.com');
  git(daemon, 'config', 'user.name', 'Daemon');
  for (const b of BRANCHES) {
    git(daemon, 'checkout', '-B', b, `origin/${b}`);
  }

  // State in the local clone.
  const state: StackFile = {
    repo: 'user/repo',
    currentStack: 'feat',
    stacks: {
      feat: {
        trunk: 'main',
        branches: BRANCHES.map((name) => ({
          name,
          tip: sha(local, name),
          pr: null,
          parentTip: null,
        })),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        restackState: null,
      },
    },
  };
  // Set parentTips correctly: branch 0 -> merge-base(main), else prev.
  const branches = state.stacks.feat!.branches;
  for (let i = 0; i < branches.length; i++) {
    const parentRef = i === 0 ? 'main' : BRANCHES[i - 1]!;
    branches[i]!.parentTip = git(local, 'merge-base', parentRef, BRANCHES[i]!);
  }
  const key = writeStateFor(local, state);

  return { origin, local, daemon, key, cleanup: [root] };
}

/** Daemon advances trunk and rebases the whole stack onto it, then force-pushes. */
function daemonRewriteStack(daemon: string): void {
  // Advance trunk.
  git(daemon, 'checkout', 'main');
  writeFile(daemon, 'trunk.ts', 'export const trunk = 1;\n');
  git(daemon, 'add', '.');
  git(daemon, 'commit', '-m', 'advance trunk');
  git(daemon, 'push', 'origin', 'main');

  // Rebase each branch onto the new parent, force-push.
  let parent = 'main';
  for (const b of BRANCHES) {
    git(daemon, 'checkout', b);
    git(daemon, 'rebase', parent);
    git(daemon, 'push', '--force', 'origin', b);
    parent = b;
  }
}

// ── Dependent-stack fixture ────────────────────────────────

const A_BRANCHES = ['user/a/1-a1', 'user/a/2-a2'];
const B_BRANCHES = ['user/b/1-b1', 'user/b/2-b2'];

interface DepFixture extends Fixture {
  aTop: string;
}

/**
 * Bare origin + stale local clone + daemon clone where:
 *   main → stack A (2 branches) ; A-top → stack B (2 branches, dependsOn A).
 * Local state records both stacks; B.trunk = A's top branch with dependsOn set.
 * Returns on B's top branch in the local clone.
 */
function makeDepFixture(): DepFixture {
  const root = mkdtempSync(join(tmpdir(), 'stack-get-dep-test-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const local = join(root, 'local');
  const daemon = join(root, 'daemon');

  git(root, 'init', '--bare', '-b', 'main', origin);

  git(root, 'clone', origin, seed);
  git(seed, 'config', 'user.email', 'test@test.com');
  git(seed, 'config', 'user.name', 'Test');
  writeFile(seed, 'README.md', '# Test\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', 'origin', 'main');

  // Stack A off main.
  let parent = 'main';
  for (let i = 0; i < A_BRANCHES.length; i++) {
    git(seed, 'checkout', '-b', A_BRANCHES[i]!, parent);
    writeFile(seed, `a${i + 1}.ts`, `export const a${i + 1} = 1;\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', `add a${i + 1}`);
    git(seed, 'push', 'origin', A_BRANCHES[i]!);
    parent = A_BRANCHES[i]!;
  }
  const aTop = A_BRANCHES[A_BRANCHES.length - 1]!;

  // Stack B off A's top branch.
  parent = aTop;
  for (let i = 0; i < B_BRANCHES.length; i++) {
    git(seed, 'checkout', '-b', B_BRANCHES[i]!, parent);
    writeFile(seed, `b${i + 1}.ts`, `export const b${i + 1} = 1;\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', `add b${i + 1}`);
    git(seed, 'push', 'origin', B_BRANCHES[i]!);
    parent = B_BRANCHES[i]!;
  }

  const allBranches = [...A_BRANCHES, ...B_BRANCHES];

  // Local clone (stale).
  git(root, 'clone', origin, local);
  git(local, 'config', 'user.email', 'test@test.com');
  git(local, 'config', 'user.name', 'Test');
  for (const b of allBranches) {
    git(local, 'checkout', '-B', b, `origin/${b}`);
  }
  git(local, 'checkout', B_BRANCHES[1]!);

  // Daemon clone.
  git(root, 'clone', origin, daemon);
  git(daemon, 'config', 'user.email', 'daemon@test.com');
  git(daemon, 'config', 'user.name', 'Daemon');
  for (const b of allBranches) {
    git(daemon, 'checkout', '-B', b, `origin/${b}`);
  }

  const mkBranches = (names: string[], parentRefs: string[]) =>
    names.map((name, i) => ({
      name,
      tip: sha(local, name),
      pr: null,
      parentTip: git(local, 'merge-base', parentRefs[i]!, name),
    }));

  const state: StackFile = {
    repo: 'user/repo',
    currentStack: 'b',
    stacks: {
      a: {
        trunk: 'main',
        branches: mkBranches(A_BRANCHES, ['main', A_BRANCHES[0]!]),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        restackState: null,
      },
      b: {
        trunk: aTop,
        dependsOn: [{ stack: 'a', branch: aTop }],
        branches: mkBranches(B_BRANCHES, [aTop, B_BRANCHES[0]!]),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        restackState: null,
      },
    },
  };
  const key = writeStateFor(local, state);

  return { origin, local, daemon, key, cleanup: [root], aTop };
}

/** Daemon advances main + rebases A then B, force-pushing every branch. */
function daemonRewriteDep(daemon: string): void {
  git(daemon, 'checkout', 'main');
  writeFile(daemon, 'trunk.ts', 'export const trunk = 1;\n');
  git(daemon, 'add', '.');
  git(daemon, 'commit', '-m', 'advance trunk');
  git(daemon, 'push', 'origin', 'main');

  let parent = 'main';
  for (const b of [...A_BRANCHES, ...B_BRANCHES]) {
    git(daemon, 'checkout', b);
    git(daemon, 'rebase', parent);
    git(daemon, 'push', '--force', 'origin', b);
    parent = b;
  }
}

// ── Cleanup ────────────────────────────────────────────────

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures) {
    try {
      rmSync(f.cleanup[0]!, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(stateFilePath(f.key), { force: true });
    } catch {}
    try {
      rmSync(join(homedir(), '.claude', 'stacks', `${f.key}.history.jsonl`), {
        force: true,
      });
    } catch {}
  }
  fixtures = [];
});

function track<T extends Fixture>(f: T): T {
  fixtures.push(f);
  return f;
}

// ── Tests ──────────────────────────────────────────────────

describe('stack get', () => {
  test('1. behind: origin strictly ahead → adopted, tip + parentTip updated', () => {
    const f = track(makeFixture());
    // Daemon adds a commit on branch 1 only (fast-forward) and pushes.
    git(f.daemon, 'checkout', BRANCHES[0]!);
    writeFile(f.daemon, 'extra.ts', 'export const x = 1;\n');
    git(f.daemon, 'add', '.');
    git(f.daemon, 'commit', '-m', 'extra on b1');
    git(f.daemon, 'push', 'origin', BRANCHES[0]!);
    const remoteSha = sha(f.daemon, BRANCHES[0]!);

    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);
    expect(sha(f.local, BRANCHES[0]!)).toBe(remoteSha);

    const st = readStateFor(f.key);
    const b0 = st.stacks.feat!.branches[0]!;
    expect(b0.tip).toBe(remoteSha);
    expect(b0.parentTip).toBe(git(f.local, 'merge-base', 'main', BRANCHES[0]!));
  });

  test('2. rewritten (daemon scenario): all branches adopted, ancestry intact', () => {
    const f = track(makeFixture());
    daemonRewriteStack(f.daemon);

    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);

    for (const b of BRANCHES) {
      git(f.local, 'fetch', 'origin');
      expect(sha(f.local, b)).toBe(sha(f.local, `origin/${b}`));
    }
    // Ancestry chain intact.
    expect(isAncestor(f.local, 'main', BRANCHES[0]!)).toBe(true);
    expect(isAncestor(f.local, BRANCHES[0]!, BRANCHES[1]!)).toBe(true);
    expect(isAncestor(f.local, BRANCHES[1]!, BRANCHES[2]!)).toBe(true);
  });

  test('3. diverged: local-only commit on b2 skipped, others adopted; --force discards', () => {
    const f = track(makeFixture());
    // Local commits real work on branch 2.
    git(f.local, 'checkout', BRANCHES[1]!);
    writeFile(f.local, 'local-only.ts', 'export const local = 1;\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'local only work');
    git(f.local, 'checkout', BRANCHES[2]!);
    const localOnlySha = sha(f.local, BRANCHES[1]!);

    daemonRewriteStack(f.daemon);
    git(f.local, 'fetch', 'origin');

    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/local commits not on the remote/i);
    // b2 kept local.
    expect(sha(f.local, BRANCHES[1]!)).toBe(localOnlySha);
    // b1 adopted.
    expect(sha(f.local, BRANCHES[0]!)).toBe(sha(f.local, `origin/${BRANCHES[0]!}`));

    // --force adopts b2 and the local-only commit is gone.
    const r2 = runGet(f.local, '--force');
    expect(r2.exitCode).toBe(0);
    git(f.local, 'fetch', 'origin');
    expect(sha(f.local, BRANCHES[1]!)).toBe(sha(f.local, `origin/${BRANCHES[1]!}`));
    const lg = git(f.local, 'log', '--format=%s', `main..${BRANCHES[1]!}`);
    expect(lg).not.toContain('local only work');
  });

  test('4. in-sync everywhere → Already up to date, no ref movement', () => {
    const f = track(makeFixture());
    const before = BRANCHES.map((b) => sha(f.local, b));

    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Already up to date');
    BRANCHES.forEach((b, i) => expect(sha(f.local, b)).toBe(before[i]));
  });

  test('5. no-remote: a branch never pushed → skipped, exit 0', () => {
    const f = track(makeFixture());
    // Add a 4th branch to state that has no remote ref.
    const st = readStateFor(f.key);
    git(f.local, 'checkout', BRANCHES[2]!);
    git(f.local, 'checkout', '-b', 'user/feat/4-d');
    writeFile(f.local, 'f4.ts', 'export const v4 = 1;\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'add f4');
    git(f.local, 'checkout', BRANCHES[2]!);
    st.stacks.feat!.branches.push({
      name: 'user/feat/4-d',
      tip: sha(f.local, 'user/feat/4-d'),
      pr: null,
      parentTip: git(f.local, 'merge-base', BRANCHES[2]!, 'user/feat/4-d'),
    });
    writeFileSync(stateFilePath(f.key), JSON.stringify(st, null, 2));
    const before = sha(f.local, 'user/feat/4-d');

    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);
    expect(sha(f.local, 'user/feat/4-d')).toBe(before);
  });

  test('6. --dry-run: zero ref/state mutation', () => {
    const f = track(makeFixture());
    daemonRewriteStack(f.daemon);
    git(f.local, 'fetch', 'origin');

    const beforeRefs = BRANCHES.map((b) => sha(f.local, b));
    const beforeMain = sha(f.local, 'main');
    // Compare the meaningful state (tips/parentTips), not raw bytes —
    // loadAndRefreshState may renormalize trailing whitespace independently.
    const beforeTips = readStateFor(f.key).stacks.feat!.branches.map((b) => ({
      tip: b.tip,
      parentTip: b.parentTip,
    }));

    const r = runGet(f.local, '--dry-run');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Dry run');

    BRANCHES.forEach((b, i) => expect(sha(f.local, b)).toBe(beforeRefs[i]));
    // The local trunk ref must NOT be fast-forwarded under --dry-run.
    expect(sha(f.local, 'main')).toBe(beforeMain);
    const afterTips = readStateFor(f.key).stacks.feat!.branches.map((b) => ({
      tip: b.tip,
      parentTip: b.parentTip,
    }));
    expect(afterTips).toEqual(beforeTips);
  });

  test('7. worktree: clean second worktree adopted; dirty skipped even with --force', () => {
    const f = track(makeFixture());
    // Check out branch 1 in a second worktree of the local clone.
    const wt = join(dirname(f.local), 'wt');
    git(f.local, 'worktree', 'add', wt, BRANCHES[0]!);

    daemonRewriteStack(f.daemon);
    git(f.local, 'fetch', 'origin');

    // Clean worktree → adopted (its HEAD moves).
    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);
    expect(sha(wt, 'HEAD')).toBe(sha(f.local, `origin/${BRANCHES[0]!}`));

    // Now make the worktree dirty and have the daemon rewrite again.
    writeFile(wt, 'f1.ts', 'export const v1 = 999;\n');
    git(f.daemon, 'checkout', BRANCHES[0]!);
    writeFile(f.daemon, 'more.ts', 'export const m = 1;\n');
    git(f.daemon, 'add', '.');
    git(f.daemon, 'commit', '-m', 'more on b1');
    git(f.daemon, 'push', '--force', 'origin', BRANCHES[0]!);
    git(f.local, 'fetch', 'origin');
    const wtTipBefore = sha(wt, 'HEAD');

    const r2 = runGet(f.local, '--force');
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).toMatch(/dirty worktree/i);
    // Worktree HEAD did NOT move.
    expect(sha(wt, 'HEAD')).toBe(wtTipBefore);

    git(f.local, 'worktree', 'remove', '--force', wt);
  });

  test('7b. dirty current branch: skipped (commit or stash), changes survive, others adopt', () => {
    const f = track(makeFixture());
    daemonRewriteStack(f.daemon);
    git(f.local, 'fetch', 'origin');

    // Dirty the current branch (branch 3).
    git(f.local, 'checkout', BRANCHES[2]!);
    writeFile(f.local, 'f3.ts', 'export const v3 = 777;\n');
    const before3 = sha(f.local, BRANCHES[2]!);

    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/commit or stash/i);
    // Branch 3 ref did not move; dirty change survives.
    expect(sha(f.local, BRANCHES[2]!)).toBe(before3);
    expect(readFileSync(join(f.local, 'f3.ts'), 'utf-8')).toContain('777');
    // Other branches adopted.
    expect(sha(f.local, BRANCHES[0]!)).toBe(sha(f.local, `origin/${BRANCHES[0]!}`));
    expect(sha(f.local, BRANCHES[1]!)).toBe(sha(f.local, `origin/${BRANCHES[1]!}`));
  });

  test('8. undo restores pre-get local tips after a --force adoption', () => {
    const f = track(makeFixture());
    // Diverge b2 locally so --force actually discards a commit.
    git(f.local, 'checkout', BRANCHES[1]!);
    writeFile(f.local, 'local-only.ts', 'export const local = 1;\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'local only work');
    git(f.local, 'checkout', BRANCHES[2]!);
    const preGetTips = BRANCHES.map((b) => sha(f.local, b));

    daemonRewriteStack(f.daemon);
    git(f.local, 'fetch', 'origin');

    const r = runGet(f.local, '--force');
    expect(r.exitCode).toBe(0);

    const cliPath = join(import.meta.dir, '..', 'cli.ts');
    const undo = Bun.spawnSync(['bun', 'run', cliPath, 'undo'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: f.local,
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(undo.exitCode).toBe(0);

    BRANCHES.forEach((b, i) => expect(sha(f.local, b)).toBe(preGetTips[i]));
  });

  test('9. sync auto-adopts daemon rewrite → nothing to sync, refs match origin', () => {
    const f = track(makeFixture());
    daemonRewriteStack(f.daemon);
    git(f.local, 'fetch', 'origin');

    const r = runSync(f.local);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/Nothing to sync/i);

    for (const b of BRANCHES) {
      expect(sha(f.local, b)).toBe(sha(f.local, `origin/${b}`));
    }
  });

  test('10. dependent: st get on B adopts ancestor A + B; ancestry intact across seam', () => {
    const f = track(makeDepFixture());
    daemonRewriteDep(f.daemon);
    git(f.local, 'fetch', 'origin');

    const r = runGet(f.local);
    expect(r.exitCode).toBe(0);
    // Adoption lines attribute the ancestor stack.
    expect(r.stderr).toContain('(stack a)');

    for (const b of [...A_BRANCHES, ...B_BRANCHES]) {
      expect(sha(f.local, b)).toBe(sha(f.local, `origin/${b}`));
    }
    // Ancestry intact, including across the A→B seam (A top is ancestor of B bottom).
    expect(isAncestor(f.local, A_BRANCHES[0]!, A_BRANCHES[1]!)).toBe(true);
    expect(isAncestor(f.local, f.aTop, B_BRANCHES[0]!)).toBe(true);
    expect(isAncestor(f.local, B_BRANCHES[0]!, B_BRANCHES[1]!)).toBe(true);
  });

  test('11. dependent: --force on B does NOT force-adopt a diverged branch in A', () => {
    const f = track(makeDepFixture());
    // Local commits real work on A's bottom branch AND B's bottom branch.
    git(f.local, 'checkout', A_BRANCHES[0]!);
    writeFile(f.local, 'a-local.ts', 'export const aLocal = 1;\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'local work in A');
    const aLocalSha = sha(f.local, A_BRANCHES[0]!);

    git(f.local, 'checkout', B_BRANCHES[0]!);
    writeFile(f.local, 'b-local.ts', 'export const bLocal = 1;\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'local work in B');
    git(f.local, 'checkout', B_BRANCHES[1]!);

    daemonRewriteDep(f.daemon);
    git(f.local, 'fetch', 'origin');

    const r = runGet(f.local, '--force');
    expect(r.exitCode).toBe(0);
    // A's diverged branch is NOT force-adopted; warn suggests the ancestor -s hint.
    expect(sha(f.local, A_BRANCHES[0]!)).toBe(aLocalSha);
    expect(r.stderr).toMatch(/st get -s a --force/);
    // B's diverged branch IS force-adopted (resolved stack honors --force).
    git(f.local, 'fetch', 'origin');
    expect(sha(f.local, B_BRANCHES[0]!)).toBe(sha(f.local, `origin/${B_BRANCHES[0]!}`));
  });

  test('12. dependent: st sync on B adopts both stacks, nothing to sync', () => {
    const f = track(makeDepFixture());
    daemonRewriteDep(f.daemon);
    git(f.local, 'fetch', 'origin');

    const r = runSync(f.local);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/Nothing to sync/i);

    for (const b of [...A_BRANCHES, ...B_BRANCHES]) {
      expect(sha(f.local, b)).toBe(sha(f.local, `origin/${b}`));
    }
  });
});
