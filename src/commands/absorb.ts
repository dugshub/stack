import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { findActiveStack, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { RestackState } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class AbsorbCommand extends Command {
  static override paths = [['absorb']];

  static override usage = Command.Usage({
    description: 'Route uncommitted fixes to the correct stack branches',
    examples: [
      ['Absorb changes into their owning branches', 'stack absorb'],
      ['Preview without making changes', 'stack absorb --dry-run'],
      ['Absorb with a custom commit message', 'stack absorb -m "fix typos"'],
    ],
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Show the plan without executing',
  });

  message = Option.String('-m,--message', {
    description: 'Commit message for absorbed changes',
  });

  async execute(): Promise<number> {
    const dirty = git.dirtyFiles();
    if (dirty.length === 0) {
      ui.info('No uncommitted changes to absorb.');
      return 0;
    }

    const state = loadState();
    const position = findActiveStack(state);
    if (!position) {
      ui.error(
        `Not on a stack branch. Use ${theme.command('stack status')} to see tracked stacks.`,
      );
      return 2;
    }

    const stack = state.stacks[position.stackName];
    if (!stack) {
      ui.error(`Stack "${position.stackName}" not found`);
      return 2;
    }

    if (stack.restackState) {
      ui.error(
        `A restack is already in progress. Use ${theme.command('stack restack --continue')} or ${theme.command('stack restack --abort')}.`,
      );
      return 2;
    }

    // Build file ownership map: file -> list of branch indices that touch it
    const ownershipMap = new Map<string, number[]>();

    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch) continue;

      const parent =
        i === 0 ? stack.trunk : stack.branches[i - 1]?.name;
      if (!parent) continue;

      const files = git.diffFiles(parent, branch.name);
      for (const file of files) {
        const owners = ownershipMap.get(file) ?? [];
        owners.push(i);
        ownershipMap.set(file, owners);
      }
    }

    // Classify dirty files
    const absorbable = new Map<number, string[]>(); // branchIndex -> files
    const conflicted: Array<{ file: string; branches: string[] }> = [];
    const unowned: string[] = [];

    for (const file of dirty) {
      const owners = ownershipMap.get(file);
      if (!owners || owners.length === 0) {
        unowned.push(file);
      } else if (owners.length === 1) {
        const branchIdx = owners[0]!;
        const files = absorbable.get(branchIdx) ?? [];
        files.push(file);
        absorbable.set(branchIdx, files);
      } else {
        conflicted.push({
          file,
          branches: owners.map((idx) => stack.branches[idx]?.name ?? '???'),
        });
      }
    }

    // Display plan
    ui.heading('Absorb plan');
    process.stderr.write('\n');

    if (absorbable.size > 0) {
      for (const [branchIdx, files] of absorbable) {
        const branchName = stack.branches[branchIdx]?.name ?? '???';
        ui.success(
          `${theme.branch(branchName)} ${theme.muted(`(${files.length} file${files.length === 1 ? '' : 's'})`)}`,
        );
        for (const file of files) {
          ui.info(`  ${file}`);
        }
      }
    }

    if (conflicted.length > 0) {
      process.stderr.write('\n');
      for (const { file, branches } of conflicted) {
        ui.warn(
          `${file} ${theme.muted(`(touched by ${branches.map((b) => theme.branch(b)).join(', ')})`)}`,
        );
      }
    }

    if (unowned.length > 0) {
      process.stderr.write('\n');
      for (const file of unowned) {
        ui.info(`${file} ${theme.muted('(not owned by any stack branch)')}`);
      }
    }

    if (absorbable.size === 0) {
      process.stderr.write('\n');
      ui.info('No files can be absorbed.');
      return 0;
    }

    if (this.dryRun) {
      process.stderr.write('\n');
      ui.info(`Dry run — no changes made. Remove ${theme.command('--dry-run')} to execute.`);
      return 0;
    }

    // Execute absorption
    process.stderr.write('\n');
    const commitMsg =
      this.message ?? 'fixup: absorb changes from stack review';
    const originalBranch = git.currentBranch();
    const repoRoot = git.repoRoot();

    // Step a: Read ALL dirty file contents into memory
    const fileContents = new Map<string, Buffer | null>();
    for (const file of dirty) {
      try {
        const fullPath = join(repoRoot, file);
        fileContents.set(file, readFileSync(fullPath));
      } catch {
        // File was deleted — track as null for git rm
        fileContents.set(file, null);
      }
    }

    // Determine which files are unabsorbed (conflicted + unowned)
    const absorbedFiles = new Set<string>();
    for (const files of absorbable.values()) {
      for (const file of files) {
        absorbedFiles.add(file);
      }
    }
    const unabsorbedFiles = dirty.filter((f) => !absorbedFiles.has(f));

    // Step b: Stash working tree and record the stash SHA for safe drop later
    git.run('stash', 'push', '-u', '-m', 'stack-absorb-temp');
    const stashSha = git.tryRun('rev-parse', 'stash@{0}').stdout;

    // Step c: Single bottom-to-top pass — rebase then commit for each branch.
    // This ensures absorb commits are always on top of the restacked chain,
    // avoiding conflicts when branches later in the stack also have absorb commits.
    const worktreeMap = git.worktreeList();
    const sortedBranches = new Set([...absorbable.keys()]);
    const lowestModifiedIndex = Math.min(...sortedBranches);
    let branchesCommitted = 0;

    // Snapshot original tips BEFORE any modifications (immutable)
    const originalTips: Record<string, string> = {};
    for (let i = lowestModifiedIndex; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch) continue;
      originalTips[branch.name] = branch.tip ?? git.revParse(branch.name);
    }

    // Also track tips for RestackState conflict recovery
    const oldTips: Record<string, string> = { ...originalTips };

    for (let i = lowestModifiedIndex; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch) continue;
      const parentBranch = stack.branches[i - 1];
      const worktreePath = worktreeMap.get(branch.name);

      // --- Rebase this branch if an upstream branch was modified ---
      if (i > lowestModifiedIndex && parentBranch) {
        const oldTip = originalTips[parentBranch.name];
        if (oldTip) {
          let rebaseResult: { ok: boolean; conflicts: string[] };

          if (worktreePath) {
            const result = Bun.spawnSync(
              ['git', 'rebase', '--onto', parentBranch.name, oldTip, branch.name],
              { stdout: 'pipe', stderr: 'pipe', cwd: worktreePath },
            );
            if (result.exitCode === 0) {
              rebaseResult = { ok: true, conflicts: [] };
            } else {
              const statusResult = Bun.spawnSync(
                ['git', 'status', '--porcelain'],
                { stdout: 'pipe', stderr: 'pipe', cwd: worktreePath },
              );
              const conflicts = statusResult.stdout
                .toString()
                .split('\n')
                .filter((line) => line.startsWith('UU '))
                .map((line) => line.slice(3));
              rebaseResult = { ok: false, conflicts };
            }
          } else {
            rebaseResult = git.rebaseOnto(parentBranch.name, oldTip, branch.name);
          }

          if (rebaseResult.ok) {
            branch.tip = git.revParse(branch.name, { cwd: worktreePath ?? undefined });
            oldTips[branch.name] = branch.tip;
            ui.success(`Rebased ${theme.branch(branch.name)}`);
          } else {
            stack.restackState = {
              fromIndex: lowestModifiedIndex,
              currentIndex: i,
              oldTips,
            };
            stack.updated = new Date().toISOString();
            saveState(state);

            ui.error(`Conflict rebasing ${theme.branch(branch.name)}`);
            if (rebaseResult.conflicts.length > 0) {
              ui.info('Conflicting files:');
              for (const file of rebaseResult.conflicts) {
                ui.info(`  ${file}`);
              }
            }
            ui.info(
              `Resolve conflicts, then run ${theme.command('stack restack --continue')}.`,
            );
            return 1;
          }
        }
      }

      // --- Commit absorb files to this branch (if any) ---
      const files = absorbable.get(i);
      if (files && files.length > 0) {
        const baseDir = worktreePath ?? repoRoot;
        if (!worktreePath) {
          git.checkout(branch.name);
        }
        for (const file of files) {
          const content = fileContents.get(file);
          if (content === null) {
            // File was deleted — remove it
            if (worktreePath) {
              Bun.spawnSync(['git', 'rm', '-f', file], {
                stdout: 'pipe', stderr: 'pipe', cwd: worktreePath,
              });
            } else {
              git.tryRun('rm', '-f', file);
            }
          } else if (content) {
            writeFileSync(join(baseDir, file), content);
          }
        }
        const addFiles = files.filter((f) => fileContents.get(f) !== null);
        if (worktreePath) {
          if (addFiles.length > 0) {
            Bun.spawnSync(['git', 'add', ...addFiles], {
              stdout: 'pipe', stderr: 'pipe', cwd: worktreePath,
            });
          }
          Bun.spawnSync(['git', 'commit', '-m', commitMsg], {
            stdout: 'pipe', stderr: 'pipe', cwd: worktreePath,
          });
          branch.tip = git.revParse(branch.name, { cwd: worktreePath });
        } else {
          if (addFiles.length > 0) {
            git.run('add', ...addFiles);
          }
          git.run('commit', '-m', commitMsg);
          branch.tip = git.revParse(branch.name);
        }
        branchesCommitted++;
        ui.success(`Committed to ${theme.branch(branch.name)}: ${files.join(', ')}`);
      }

      saveState(state);
    }

    // Step e: Return to original branch
    git.checkout(originalBranch);

    // Step f: Drop the absorb stash by matching SHA (safe if other stashes were created)
    if (stashSha) {
      const listResult = git.tryRun('stash', 'list', '--format=%H');
      if (listResult.ok) {
        const shas = listResult.stdout.split('\n');
        const idx = shas.indexOf(stashSha);
        if (idx >= 0) {
          git.tryRun('stash', 'drop', `stash@{${idx}}`);
        }
      }
    }

    // Step g: Write back unabsorbed file contents
    if (unabsorbedFiles.length > 0) {
      for (const file of unabsorbedFiles) {
        const content = fileContents.get(file);
        const fullPath = join(repoRoot, file);
        if (content === null) {
          // File was deleted — re-delete it
          if (existsSync(fullPath)) {
            unlinkSync(fullPath);
          }
        } else if (content !== undefined) {
          writeFileSync(fullPath, content);
        }
      }
      process.stderr.write('\n');
      ui.info(
        `Restored ${unabsorbedFiles.length} unabsorbed file${unabsorbedFiles.length === 1 ? '' : 's'} to working tree.`,
      );
    }

    // Step h: Report results
    stack.updated = new Date().toISOString();
    saveState(state);

    process.stderr.write('\n');
    ui.success(
      `Absorbed changes into ${branchesCommitted} branch${branchesCommitted === 1 ? '' : 'es'}.`,
    );
    return 0;
  }
}
