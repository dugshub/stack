import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { StackFile } from '../lib/types.js';

// ── Helpers ────────────────────────────────────────────────

/** Run a git command in a directory, throw on failure */
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

/** Run the stack CLI in a directory, return exit code + stderr */
function runAbsorb(cwd: string, ...extraArgs: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const cliPath = join(import.meta.dir, '..', 'cli.ts');
  const result = Bun.spawnSync(['bun', 'run', cliPath, 'absorb', ...extraArgs], {
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

/** Read a file from the repo */
function readFile(cwd: string, filePath: string): string {
  return readFileSync(join(cwd, filePath), 'utf-8');
}

/** Write a file to the repo */
function writeFile(cwd: string, filePath: string, content: string): void {
  const dir = join(cwd, filePath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, filePath), content, 'utf-8');
}

/** Get the state file path for a repo */
function stateFilePath(repoName: string): string {
  return join(homedir(), '.claude', 'stacks', `${repoName}.json`);
}

/** Write stack state for a repo */
function writeState(repoName: string, state: StackFile): void {
  const dir = join(homedir(), '.claude', 'stacks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFilePath(repoName), JSON.stringify(state, null, 2), 'utf-8');
}

/** Read stack state for a repo */
function readState(repoName: string): StackFile {
  return JSON.parse(readFileSync(stateFilePath(repoName), 'utf-8'));
}

/** Get current branch name */
function currentBranch(cwd: string): string {
  return git(cwd, 'branch', '--show-current');
}

/** Get the HEAD commit SHA */
function headSha(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Get commit count on a branch relative to main */
function commitCount(cwd: string, branch: string): number {
  const output = git(cwd, 'log', '--oneline', `main..${branch}`);
  if (!output) return 0;
  return output.split('\n').length;
}

/** Get the content of a file at a specific branch */
function fileAtBranch(cwd: string, branch: string, filePath: string): string {
  return git(cwd, 'show', `${branch}:${filePath}`);
}

/** Check if working tree is clean (tracked files only) */
function isClean(cwd: string): boolean {
  const result = git(cwd, 'status', '--porcelain', '-uno');
  return result.length === 0;
}

/** Get list of modified files in working tree */
function modifiedFiles(cwd: string): string[] {
  const result = git(cwd, 'diff', '--name-only', 'HEAD');
  if (!result) return [];
  return result.split('\n');
}

// ── Test Fixtures ──────────────────────────────────────────

interface TestRepo {
  dir: string;
  name: string;
}

/**
 * Create a test repo with a 3-branch stack:
 *   main → branch-1 (adds auth.ts) → branch-2 (adds routes.ts) → branch-3 (adds tests.ts)
 * Each branch adds a unique file. Returns on branch-3 (top of stack).
 */
function createBasicStack(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'stack-absorb-test-'));
  const name = basename(dir);

  // Init repo with an initial commit on main
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFile(dir, 'README.md', '# Test Repo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial commit');

  // Branch 1: adds auth.ts
  git(dir, 'checkout', '-b', 'test/stack/1-auth');
  writeFile(dir, 'src/auth.ts', 'export function login() { return true; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'add auth');
  const tip1 = headSha(dir);

  // Branch 2: adds routes.ts
  git(dir, 'checkout', '-b', 'test/stack/2-routes');
  writeFile(dir, 'src/routes.ts', 'export function getRoutes() { return []; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'add routes');
  const tip2 = headSha(dir);

  // Branch 3: adds tests.ts
  git(dir, 'checkout', '-b', 'test/stack/3-tests');
  writeFile(dir, 'src/tests.ts', 'export function runTests() { return 0; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'add tests');
  const tip3 = headSha(dir);

  // Write stack state
  const state: StackFile = {
    repo: 'test/repo',
    currentStack: null,
    stacks: {
      stack: {
        trunk: 'main',
        branches: [
          { name: 'test/stack/1-auth', tip: tip1, pr: null },
          { name: 'test/stack/2-routes', tip: tip2, pr: null },
          { name: 'test/stack/3-tests', tip: tip3, pr: null },
        ],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        restackState: null,
      },
    },
  };
  writeState(name, state);

  return { dir, name };
}

/**
 * Create a stack where branch-1 and branch-3 both modify shared.ts:
 *   main → branch-1 (adds auth.ts + shared.ts) → branch-2 (adds routes.ts) → branch-3 (modifies shared.ts)
 */
function createOverlappingStack(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'stack-absorb-overlap-'));
  const name = basename(dir);

  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFile(dir, 'README.md', '# Test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');

  // Branch 1: adds auth.ts and shared.ts
  git(dir, 'checkout', '-b', 'test/stack/1-auth');
  writeFile(dir, 'src/auth.ts', 'export function login() { return true; }\n');
  writeFile(dir, 'src/shared.ts', 'export const VERSION = "1.0";\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'add auth + shared');
  const tip1 = headSha(dir);

  // Branch 2: adds routes.ts (doesn't touch shared.ts)
  git(dir, 'checkout', '-b', 'test/stack/2-routes');
  writeFile(dir, 'src/routes.ts', 'export function getRoutes() { return []; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'add routes');
  const tip2 = headSha(dir);

  // Branch 3: modifies shared.ts AND adds tests.ts
  git(dir, 'checkout', '-b', 'test/stack/3-tests');
  writeFile(dir, 'src/shared.ts', 'export const VERSION = "2.0";\nexport const NAME = "test";\n');
  writeFile(dir, 'src/tests.ts', 'export function runTests() { return 0; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'add tests + update shared');
  const tip3 = headSha(dir);

  const state: StackFile = {
    repo: 'test/repo',
    currentStack: null,
    stacks: {
      stack: {
        trunk: 'main',
        branches: [
          { name: 'test/stack/1-auth', tip: tip1, pr: null },
          { name: 'test/stack/2-routes', tip: tip2, pr: null },
          { name: 'test/stack/3-tests', tip: tip3, pr: null },
        ],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        restackState: null,
      },
    },
  };
  writeState(name, state);

  return { dir, name };
}

// ── Cleanup ────────────────────────────────────────────────

let repos: TestRepo[] = [];

afterEach(() => {
  for (const repo of repos) {
    try {
      rmSync(repo.dir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(stateFilePath(repo.name), { force: true });
    } catch {}
  }
  repos = [];
});

function trackRepo(repo: TestRepo): TestRepo {
  repos.push(repo);
  return repo;
}

// ── Tests ──────────────────────────────────────────────────

describe('stack absorb', () => {
  describe('preconditions', () => {
    test('exits cleanly when no dirty files', () => {
      const repo = trackRepo(createBasicStack());
      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('No uncommitted changes');
    });

    test('errors when not on a stack branch', () => {
      const repo = trackRepo(createBasicStack());
      git(repo.dir, 'checkout', 'main');
      // Dirty a file so we get past the "no changes" check
      writeFile(repo.dir, 'README.md', '# Modified\n');
      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Not on a stack branch');
    });

    test('errors when restack is in progress', () => {
      const repo = trackRepo(createBasicStack());
      // Modify state to have an active restack
      const state = readState(repo.name);
      state.stacks.stack!.restackState = {
        fromIndex: 0,
        currentIndex: 1,
        oldTips: {},
      };
      writeState(repo.name, state);
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');
      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('restack is already in progress');
    });
  });

  describe('file classification', () => {
    test('identifies single-owner files as absorbable', () => {
      const repo = trackRepo(createBasicStack());
      // Modify auth.ts (owned by branch 1 only)
      writeFile(repo.dir, 'src/auth.ts', 'export function login() { return false; }\n');
      const result = runAbsorb(repo.dir, '--dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('test/stack/1-auth');
      expect(result.stderr).toContain('src/auth.ts');
      expect(result.stderr).toContain('Dry run');
    });

    test('identifies multi-owner files as conflicted', () => {
      const repo = trackRepo(createOverlappingStack());
      // Modify shared.ts (owned by branch 1 AND branch 3)
      writeFile(repo.dir, 'src/shared.ts', 'export const VERSION = "3.0";\n');
      const result = runAbsorb(repo.dir, '--dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('shared.ts');
      // Should mention it's touched by multiple branches
      expect(result.stderr).toMatch(/touched by/i);
    });

    test('identifies new files as unowned', () => {
      const repo = trackRepo(createBasicStack());
      // Create a new file not in any branch
      writeFile(repo.dir, 'src/newfile.ts', 'new content\n');
      git(repo.dir, 'add', 'src/newfile.ts');
      const result = runAbsorb(repo.dir, '--dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('newfile.ts');
      expect(result.stderr).toContain('not owned');
    });

    test('handles mixed classification correctly', () => {
      const repo = trackRepo(createOverlappingStack());
      // auth.ts → absorbable (branch 1 only)
      writeFile(repo.dir, 'src/auth.ts', 'export function login() { return false; }\n');
      // shared.ts → conflicted (branch 1 + 3)
      writeFile(repo.dir, 'src/shared.ts', 'export const VERSION = "3.0";\n');
      // newfile.ts → unowned
      writeFile(repo.dir, 'src/newfile.ts', 'new\n');
      git(repo.dir, 'add', 'src/newfile.ts');

      const result = runAbsorb(repo.dir, '--dry-run');
      expect(result.exitCode).toBe(0);
      // Should show auth.ts as absorbable
      expect(result.stderr).toContain('auth.ts');
      expect(result.stderr).toContain('test/stack/1-auth');
      // Should show shared.ts as conflicted
      expect(result.stderr).toMatch(/shared\.ts.*touched by/s);
      // Should show newfile.ts as unowned
      expect(result.stderr).toContain('newfile.ts');
    });
  });

  describe('dry run', () => {
    test('--dry-run makes no changes to git state', () => {
      const repo = trackRepo(createBasicStack());
      const beforeTip = headSha(repo.dir);
      writeFile(repo.dir, 'src/auth.ts', 'export function login() { return false; }\n');

      const result = runAbsorb(repo.dir, '--dry-run');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dry run');

      // Working tree should still be dirty
      expect(isClean(repo.dir)).toBe(false);
      // HEAD should not have moved
      expect(headSha(repo.dir)).toBe(beforeTip);
      // Should still be on the same branch
      expect(currentBranch(repo.dir)).toBe('test/stack/3-tests');
    });
  });

  describe('basic absorption', () => {
    test('absorbs a single file into the correct branch', () => {
      const repo = trackRepo(createBasicStack());
      const fixedContent = 'export function login() { return false; }\n';
      writeFile(repo.dir, 'src/auth.ts', fixedContent);

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Committed to');
      expect(result.stderr).toContain('test/stack/1-auth');

      // Verify the fix landed in branch 1
      const contentAtBranch1 = fileAtBranch(repo.dir, 'test/stack/1-auth', 'src/auth.ts');
      expect(contentAtBranch1).toBe(fixedContent.trim());

      // Verify it propagated through restack to branch 2 and 3
      const contentAtBranch2 = fileAtBranch(repo.dir, 'test/stack/2-routes', 'src/auth.ts');
      expect(contentAtBranch2).toBe(fixedContent.trim());
      const contentAtBranch3 = fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/auth.ts');
      expect(contentAtBranch3).toBe(fixedContent.trim());
    });

    test('absorbs files into multiple branches', () => {
      const repo = trackRepo(createBasicStack());
      const fixedAuth = 'export function login() { /* fixed */ return false; }\n';
      const fixedRoutes = 'export function getRoutes() { return ["/api"]; }\n';
      writeFile(repo.dir, 'src/auth.ts', fixedAuth);
      writeFile(repo.dir, 'src/routes.ts', fixedRoutes);

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);

      // auth.ts should be in branch 1
      expect(fileAtBranch(repo.dir, 'test/stack/1-auth', 'src/auth.ts')).toBe(fixedAuth.trim());
      // routes.ts should be in branch 2
      expect(fileAtBranch(repo.dir, 'test/stack/2-routes', 'src/routes.ts')).toBe(fixedRoutes.trim());

      // Both should propagate to branch 3
      expect(fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/auth.ts')).toBe(fixedAuth.trim());
      expect(fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/routes.ts')).toBe(fixedRoutes.trim());
    });

    test('absorbs file into top branch without restacking', () => {
      const repo = trackRepo(createBasicStack());
      const fixedTests = 'export function runTests() { return 1; }\n';
      writeFile(repo.dir, 'src/tests.ts', fixedTests);

      const beforeTip1 = git(repo.dir, 'rev-parse', 'test/stack/1-auth');
      const beforeTip2 = git(repo.dir, 'rev-parse', 'test/stack/2-routes');

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);

      // Branch 3 should have the fix
      expect(fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/tests.ts')).toBe(fixedTests.trim());

      // Branches 1 and 2 should NOT have moved (no restack needed)
      expect(git(repo.dir, 'rev-parse', 'test/stack/1-auth')).toBe(beforeTip1);
      expect(git(repo.dir, 'rev-parse', 'test/stack/2-routes')).toBe(beforeTip2);
    });
  });

  describe('branch and working tree restoration', () => {
    test('returns to original branch after absorption', () => {
      const repo = trackRepo(createBasicStack());
      expect(currentBranch(repo.dir)).toBe('test/stack/3-tests');
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(currentBranch(repo.dir)).toBe('test/stack/3-tests');
    });

    test('returns to mid-stack branch after absorption', () => {
      const repo = trackRepo(createBasicStack());
      git(repo.dir, 'checkout', 'test/stack/2-routes');
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(currentBranch(repo.dir)).toBe('test/stack/2-routes');
    });

    test('working tree is clean after absorbing all files', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');
      writeFile(repo.dir, 'src/routes.ts', 'modified\n');

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(isClean(repo.dir)).toBe(true);
    });

    test('restores unabsorbed files to working tree', () => {
      const repo = trackRepo(createOverlappingStack());
      // auth.ts is absorbable, shared.ts is conflicted
      writeFile(repo.dir, 'src/auth.ts', 'fixed auth\n');
      writeFile(repo.dir, 'src/shared.ts', 'fixed shared\n');

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Restored');

      // shared.ts should be back in the working tree (unabsorbed)
      expect(readFile(repo.dir, 'src/shared.ts')).toBe('fixed shared\n');
      // auth.ts should be clean (absorbed)
      expect(modifiedFiles(repo.dir)).toContain('src/shared.ts');
      expect(modifiedFiles(repo.dir)).not.toContain('src/auth.ts');
    });
  });

  describe('commit messages', () => {
    test('uses default commit message', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      runAbsorb(repo.dir);

      // Check the commit message on branch 1
      const log = git(repo.dir, 'log', '-1', '--format=%s', 'test/stack/1-auth');
      expect(log).toBe('fixup: absorb changes from stack review');
    });

    test('uses custom commit message via -m flag', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      runAbsorb(repo.dir, '-m', 'fix: typo in auth');

      const log = git(repo.dir, 'log', '-1', '--format=%s', 'test/stack/1-auth');
      expect(log).toBe('fix: typo in auth');
    });
  });

  describe('restacking', () => {
    test('downstream branches have correct ancestry after restack', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified auth\n');

      runAbsorb(repo.dir);

      // Branch 2 should be descendant of branch 1
      const isDesc = Bun.spawnSync(
        ['git', 'merge-base', '--is-ancestor', 'test/stack/1-auth', 'test/stack/2-routes'],
        { cwd: repo.dir },
      );
      expect(isDesc.exitCode).toBe(0);

      // Branch 3 should be descendant of branch 2
      const isDesc2 = Bun.spawnSync(
        ['git', 'merge-base', '--is-ancestor', 'test/stack/2-routes', 'test/stack/3-tests'],
        { cwd: repo.dir },
      );
      expect(isDesc2.exitCode).toBe(0);
    });

    test('all branch files are preserved after restack', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'export function login() { return "v2"; }\n');

      runAbsorb(repo.dir);

      // Branch 1 should have auth.ts
      expect(fileAtBranch(repo.dir, 'test/stack/1-auth', 'src/auth.ts')).toContain('v2');
      // Branch 2 should have auth.ts + routes.ts
      expect(fileAtBranch(repo.dir, 'test/stack/2-routes', 'src/auth.ts')).toContain('v2');
      expect(fileAtBranch(repo.dir, 'test/stack/2-routes', 'src/routes.ts')).toContain('getRoutes');
      // Branch 3 should have all three files
      expect(fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/auth.ts')).toContain('v2');
      expect(fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/routes.ts')).toContain('getRoutes');
      expect(fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/tests.ts')).toContain('runTests');
    });

    test('state tips are updated after absorption', () => {
      const repo = trackRepo(createBasicStack());
      const beforeState = readState(repo.name);
      const beforeTips = beforeState.stacks.stack!.branches.map((b) => b.tip);

      writeFile(repo.dir, 'src/auth.ts', 'modified\n');
      runAbsorb(repo.dir);

      const afterState = readState(repo.name);
      const afterTips = afterState.stacks.stack!.branches.map((b) => b.tip);

      // All tips should have changed (branch 1 got a commit, 2+3 got restacked)
      for (let i = 0; i < beforeTips.length; i++) {
        expect(afterTips[i]).not.toBe(beforeTips[i]);
      }

      // Tips in state should match actual branch HEADs
      for (const branch of afterState.stacks.stack!.branches) {
        const actualTip = git(repo.dir, 'rev-parse', branch.name);
        expect(branch.tip).toBe(actualTip);
      }
    });

    test('only restacks from the lowest modified branch', () => {
      const repo = trackRepo(createBasicStack());
      const beforeTip1 = git(repo.dir, 'rev-parse', 'test/stack/1-auth');

      // Only modify routes.ts (branch 2) — branch 1 should NOT change
      writeFile(repo.dir, 'src/routes.ts', 'export function getRoutes() { return ["/v2"]; }\n');
      runAbsorb(repo.dir);

      // Branch 1 should not have moved
      expect(git(repo.dir, 'rev-parse', 'test/stack/1-auth')).toBe(beforeTip1);
      // Branch 2 should have a new commit
      expect(git(repo.dir, 'rev-parse', 'test/stack/2-routes')).not.toBe(beforeTip1);
    });
  });

  describe('edge cases', () => {
    test('handles all files being conflicted', () => {
      const repo = trackRepo(createOverlappingStack());
      // Only modify shared.ts which is owned by multiple branches
      writeFile(repo.dir, 'src/shared.ts', 'conflicted content\n');

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('No files can be absorbed');
    });

    test('handles all files being unowned', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/brand-new.ts', 'new file\n');
      git(repo.dir, 'add', 'src/brand-new.ts');

      const result = runAbsorb(repo.dir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('No files can be absorbed');
    });

    test('adds a new commit rather than amending', () => {
      const repo = trackRepo(createBasicStack());
      const beforeCount = commitCount(repo.dir, 'test/stack/1-auth');
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      runAbsorb(repo.dir);

      const afterCount = commitCount(repo.dir, 'test/stack/1-auth');
      // Should have one MORE commit (fixup), not the same count (amend)
      expect(afterCount).toBe(beforeCount + 1);
    });

    test('stash is cleaned up after successful absorb', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      runAbsorb(repo.dir);

      // Should be no stash entries (or at least no stack-absorb-temp)
      const stashResult = Bun.spawnSync(['git', 'stash', 'list'], {
        stdout: 'pipe',
        cwd: repo.dir,
      });
      const stashOutput = stashResult.stdout.toString();
      expect(stashOutput).not.toContain('stack-absorb-temp');
    });
  });

  describe('manual routing (--branch)', () => {
    test('--branch routes file to specified branch', () => {
      const repo = trackRepo(createBasicStack());
      // Modify routes.ts (owned by branch 2) and route it to branch 2 manually
      writeFile(repo.dir, 'src/routes.ts', 'export function getRoutes() { return ["/manual"]; }\n');

      const result = runAbsorb(repo.dir, '--branch', '2', 'src/routes.ts');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Committed to');

      // Verify it landed in branch 2
      const content = fileAtBranch(repo.dir, 'test/stack/2-routes', 'src/routes.ts');
      expect(content).toContain('/manual');
    });

    test('--branch with non-dirty file warns and skips', () => {
      const repo = trackRepo(createBasicStack());
      // Also dirty one valid file so the command doesn't error on "all clean"
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      const result = runAbsorb(repo.dir, '--branch', '1', 'src/auth.ts', 'src/clean-file.ts');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('clean-file.ts is not dirty');
    });

    test('--branch out of range errors', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      // Index 0 is out of range (1-based)
      const result0 = runAbsorb(repo.dir, '--branch', '0', 'src/auth.ts');
      expect(result0.exitCode).toBe(2);
      expect(result0.stderr).toContain('Branch index must be between 1 and');

      // Index > branch count is out of range
      const result99 = runAbsorb(repo.dir, '--branch', '99', 'src/auth.ts');
      expect(result99.exitCode).toBe(2);
      expect(result99.stderr).toContain('Branch index must be between 1 and');
    });

    test('--branch without files errors', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      const result = runAbsorb(repo.dir, '--branch', '1');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--branch requires file paths');
    });

    test('--branch with only non-dirty positional args errors after warnings', () => {
      const repo = trackRepo(createBasicStack());
      // Dirty a file that is NOT in our positional args
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      const result = runAbsorb(repo.dir, '--branch', '1', 'src/clean-file.ts');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('is not dirty');
      expect(result.stderr).toContain('None of the specified files have uncommitted changes');
    });

    test('--branch overrides ownership', () => {
      const repo = trackRepo(createBasicStack());
      // auth.ts is owned by branch 1, but we route it to branch 2
      writeFile(repo.dir, 'src/auth.ts', 'export function login() { return "overridden"; }\n');

      const result = runAbsorb(repo.dir, '--branch', '2', 'src/auth.ts');
      expect(result.exitCode).toBe(0);

      // Verify it landed in branch 2, not branch 1
      const contentAtBranch2 = fileAtBranch(repo.dir, 'test/stack/2-routes', 'src/auth.ts');
      expect(contentAtBranch2).toContain('overridden');
    });

    test('--branch + auto-absorb combined', () => {
      const repo = trackRepo(createOverlappingStack());
      // auth.ts → auto-routable to branch 1
      writeFile(repo.dir, 'src/auth.ts', 'export function login() { return "auto"; }\n');
      // shared.ts → conflicted (branch 1 + 3), manually route to branch 3
      writeFile(repo.dir, 'src/shared.ts', 'export const VERSION = "manual";\n');
      // newfile.ts → unowned, should be restored
      writeFile(repo.dir, 'src/newfile.ts', 'unowned content\n');
      git(repo.dir, 'add', 'src/newfile.ts');

      const result = runAbsorb(repo.dir, '--branch', '3', 'src/shared.ts');
      expect(result.exitCode).toBe(0);

      // auth.ts should be auto-absorbed into branch 1
      expect(fileAtBranch(repo.dir, 'test/stack/1-auth', 'src/auth.ts')).toContain('auto');
      // shared.ts should be manually routed to branch 3
      expect(fileAtBranch(repo.dir, 'test/stack/3-tests', 'src/shared.ts')).toContain('manual');
      // newfile.ts should be restored to working tree
      expect(readFile(repo.dir, 'src/newfile.ts')).toBe('unowned content\n');
    });

    test('--branch dry-run shows manual annotation', () => {
      const repo = trackRepo(createBasicStack());
      writeFile(repo.dir, 'src/auth.ts', 'modified\n');

      const result = runAbsorb(repo.dir, '--dry-run', '--branch', '2', 'src/auth.ts');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('(manual)');
      expect(result.stderr).toContain('Dry run');
    });
  });

  describe('5-branch deep stack', () => {
    test('absorbs across a deep stack correctly', () => {
      const dir = mkdtempSync(join(tmpdir(), 'stack-absorb-deep-'));
      const name = basename(dir);
      const repo = trackRepo({ dir, name });

      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.email', 'test@test.com');
      git(dir, 'config', 'user.name', 'Test');
      writeFile(dir, 'README.md', '# Deep Stack\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-m', 'initial');

      const branchNames: string[] = [];
      const tips: string[] = [];

      // Create 5 branches, each adding a unique file
      for (let i = 1; i <= 5; i++) {
        const branchName = `test/deep/${i}-feature-${i}`;
        branchNames.push(branchName);
        git(dir, 'checkout', '-b', branchName);
        writeFile(dir, `src/feature${i}.ts`, `export const feature${i} = true;\n`);
        git(dir, 'add', '.');
        git(dir, 'commit', '-m', `add feature ${i}`);
        tips.push(headSha(dir));
      }

      const state: StackFile = {
        repo: 'test/repo',
        currentStack: null,
        stacks: {
          deep: {
            trunk: 'main',
            branches: branchNames.map((name, i) => ({
              name,
              tip: tips[i]!,
              pr: null,
            })),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            restackState: null,
          },
        },
      };
      writeState(name, state);

      // On branch 5 (top), fix files in branches 1, 3, and 5
      const fix1 = 'export const feature1 = "FIXED";\n';
      const fix3 = 'export const feature3 = "FIXED";\n';
      const fix5 = 'export const feature5 = "FIXED";\n';
      writeFile(dir, 'src/feature1.ts', fix1);
      writeFile(dir, 'src/feature3.ts', fix3);
      writeFile(dir, 'src/feature5.ts', fix5);

      const result = runAbsorb(dir);
      expect(result.exitCode).toBe(0);

      // Verify fix1 is in branch 1 and propagates
      expect(fileAtBranch(dir, branchNames[0]!, 'src/feature1.ts')).toContain('FIXED');
      expect(fileAtBranch(dir, branchNames[4]!, 'src/feature1.ts')).toContain('FIXED');

      // Verify fix3 is in branch 3 and propagates
      expect(fileAtBranch(dir, branchNames[2]!, 'src/feature3.ts')).toContain('FIXED');
      expect(fileAtBranch(dir, branchNames[4]!, 'src/feature3.ts')).toContain('FIXED');

      // Verify fix5 is in branch 5
      expect(fileAtBranch(dir, branchNames[4]!, 'src/feature5.ts')).toContain('FIXED');

      // Verify untouched files are still correct
      expect(fileAtBranch(dir, branchNames[1]!, 'src/feature2.ts')).toContain('feature2 = true');
      expect(fileAtBranch(dir, branchNames[3]!, 'src/feature4.ts')).toContain('feature4 = true');

      // Verify ancestry chain is intact
      for (let i = 1; i < branchNames.length; i++) {
        const isAncestor = Bun.spawnSync(
          ['git', 'merge-base', '--is-ancestor', branchNames[i - 1]!, branchNames[i]!],
          { cwd: dir },
        );
        expect(isAncestor.exitCode).toBe(0);
      }

      // Back on original branch
      expect(currentBranch(dir)).toBe(branchNames[4]!);
    });
  });
});
