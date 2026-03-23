import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { rebaseBranch } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

function generateCommitMessage(
  files: string[],
  fileContents: Map<string, Buffer | null>,
): string {
  const basenames = files.map((f) => f.split('/').pop() || f);
  const allDeleted = files.every((f) => fileContents.get(f) === null);
  const verb = allDeleted ? 'remove' : 'update';

  if (basenames.length === 1) {
    return `fixup: ${verb} ${basenames[0]}`;
  }
  if (basenames.length === 2) {
    return `fixup: ${verb} ${basenames[0]}, ${basenames[1]}`;
  }
  return `fixup: ${verb} ${basenames[0]}, ${basenames[1]} (+${basenames.length - 2} more)`;
}

export class AbsorbCommand extends Command {
  static override paths = [['branch', 'absorb'], ['absorb']];

  static override usage = Command.Usage({
    description: 'Route uncommitted fixes to the correct stack branches',
    examples: [
      ['Absorb changes into their owning branches', 'st absorb'],
      ['Preview without making changes', 'st absorb --dry-run'],
      ['Route files to branch 5 manually', 'st absorb --branch 5 GroupedTable.tsx'],
      ['Route files to specific branches', 'st absorb --route 4-goldmark:goldmark.go --route 7-input:registry.go'],
      ['Absorb with a custom commit message', 'st absorb -m "fix typos"'],
      ['Skip interactive prompts', 'st absorb --no-prompt'],
    ],
  });

  stackName = Option.String('--stack,-s', {
    description: 'Target stack by name',
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Show the plan without executing',
  });

  message = Option.String('-m,--message', {
    description: 'Commit message for absorbed changes',
  });

  branchTarget = Option.String('--branch,-b', {
    description: '1-based branch index to route files to',
  });

  route = Option.Array('--route', {
    description: 'Route files to branches as branch:file pairs',
  });

  noPrompt = Option.Boolean('--no-prompt', false, {
    description: 'Disable interactive prompts for ambiguous/unowned files',
  });

  files = Option.Rest();

  async execute(): Promise<number> {
    const state = loadAndRefreshState();

    let resolved: Awaited<ReturnType<typeof resolveStack>>;
    try {
      resolved = await resolveStack({ state, explicitName: this.stackName });
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      return 2;
    }

    const { stackName: resolvedName, stack, position } = resolved;
    if (!stack) {
      ui.error(`Stack "${resolvedName}" not found`);
      return 2;
    }

    if (!position) {
      ui.error('Not on a stack branch. Switch to a branch in the stack first.');
      return 2;
    }

    // If HEAD is ahead of the branch's recorded tip, soft-reset to turn
    // committed changes back into staged changes for absorption.
    const branchTip = position ? stack.branches[position.index]?.tip : undefined;
    if (branchTip) {
      const head = git.revParse('HEAD');
      if (head !== branchTip) {
        const commits = git.log(`${branchTip}..HEAD`);
        if (commits.length > 0) {
          git.run('reset', '--soft', branchTip);
          ui.info(
            `Unstaged ${commits.length} commit${commits.length === 1 ? '' : 's'} for absorption.`,
          );
        }
      }
    }

    const dirty = git.dirtyFiles();
    if (dirty.length === 0) {
      ui.info('No uncommitted changes to absorb.');
      return 0;
    }

    if (stack.restackState) {
      ui.error(
        `A restack is already in progress. Use ${theme.command('st continue')} or ${theme.command('st abort')}.`,
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

    // Manual routing: --branch N file1 file2 and --route branch:file
    const manualRoute = new Map<number, string[]>(); // branchIndex -> files
    const manualFiles = new Set<string>();
    const hasRouteFlags = this.route && this.route.length > 0;

    if (this.branchTarget !== undefined) {
      const idx = parseInt(this.branchTarget, 10) - 1; // 1-based → 0-based
      if (Number.isNaN(idx) || idx < 0 || idx >= stack.branches.length) {
        ui.error(`Branch index must be between 1 and ${stack.branches.length}`);
        return 2;
      }

      const restArgs = this.files ?? [];
      if (restArgs.length === 0 && !hasRouteFlags) {
        ui.error('--branch requires file paths as positional arguments');
        return 2;
      }

      if (restArgs.length > 0) {
        const validFiles: string[] = [];
        for (const file of restArgs) {
          if (dirty.includes(file)) {
            validFiles.push(file);
            manualFiles.add(file);
          } else {
            ui.warn(`${file} is not dirty — skipping`);
          }
        }

        if (validFiles.length > 0) {
          manualRoute.set(idx, validFiles);
        } else if (!hasRouteFlags) {
          ui.error('None of the specified files have uncommitted changes');
          return 2;
        }
      }
    }

    // Parse --route flags: branch:file pairs
    if (hasRouteFlags) {
      for (const entry of this.route!) {
        const colonIdx = entry.indexOf(':');
        if (colonIdx === -1) {
          ui.error(`Invalid --route format: "${entry}" (expected branch:file)`);
          return 2;
        }

        const identifier = entry.slice(0, colonIdx);
        const filePath = entry.slice(colonIdx + 1);

        if (!identifier || !filePath) {
          ui.error(`Invalid --route format: "${entry}" (expected branch:file)`);
          return 2;
        }

        // Resolve branch identifier: try integer first, then substring match
        let branchIdx: number;
        const parsed = parseInt(identifier, 10);
        if (!Number.isNaN(parsed) && String(parsed) === identifier) {
          branchIdx = parsed - 1; // 1-based → 0-based
          if (branchIdx < 0 || branchIdx >= stack.branches.length) {
            ui.error(`Branch index ${parsed} is out of range (1-${stack.branches.length})`);
            return 2;
          }
        } else {
          const matches: number[] = [];
          for (let i = 0; i < stack.branches.length; i++) {
            if (stack.branches[i]?.name.includes(identifier)) {
              matches.push(i);
            }
          }
          if (matches.length === 0) {
            ui.error(`No branch matching "${identifier}"`);
            return 2;
          }
          if (matches.length > 1) {
            const names = matches.map((i) => stack.branches[i]?.name ?? '???');
            ui.error(`Ambiguous branch identifier "${identifier}" matches: ${names.join(', ')}`);
            return 2;
          }
          branchIdx = matches[0]!;
        }

        // Validate file against dirty set
        if (!dirty.includes(filePath)) {
          ui.warn(`${filePath} is not dirty — skipping`);
          continue;
        }

        manualFiles.add(filePath);
        const existing = manualRoute.get(branchIdx) ?? [];
        existing.push(filePath);
        manualRoute.set(branchIdx, existing);
      }
    }

    // Classify dirty files
    const absorbable = new Map<number, string[]>(); // branchIndex -> files
    const conflicted: Array<{ file: string; branches: string[] }> = [];
    const unowned: string[] = [];

    for (const file of dirty) {
      if (manualFiles.has(file)) continue; // handled by --branch
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

    // Merge manual routes into absorbable map before display and early-exit guard
    for (const [idx, files] of manualRoute) {
      const existing = absorbable.get(idx) ?? [];
      existing.push(...files);
      absorbable.set(idx, existing);
    }

    // Track files resolved via interactive prompts
    const interactiveFiles = new Set<string>();
    const isInteractive = process.stdin.isTTY && !this.noPrompt;

    // Interactive prompts for ambiguous/unowned files
    if ((conflicted.length > 0 || unowned.length > 0) && isInteractive) {
      // Prompt for each ambiguous file
      for (const { file, branches } of conflicted) {
        const owners = ownershipMap.get(file) ?? [];
        const result = await p.select({
          message: `${file} is touched by ${branches.join(' and ')}`,
          options: [
            ...owners.map((idx) => ({
              value: idx,
              label: `branch-${idx + 1} (${stack.branches[idx]?.name ?? '???'})`,
            })),
            { value: -1, label: '[skip]' },
          ],
        });

        if (p.isCancel(result)) {
          process.exit(130);
        }

        if (result !== -1) {
          const branchIdx = result as number;
          const existing = absorbable.get(branchIdx) ?? [];
          existing.push(file);
          absorbable.set(branchIdx, existing);
          interactiveFiles.add(file);
        }
      }

      // Prompt for each unowned file
      for (const file of unowned) {
        const result = await p.select({
          message: `${file} is not owned by any branch`,
          options: [
            ...stack.branches.map((b, idx) => ({
              value: idx,
              label: `branch-${idx + 1} (${b.name})`,
            })),
            { value: -1, label: '[skip]' },
          ],
        });

        if (p.isCancel(result)) {
          process.exit(130);
        }

        if (result !== -1) {
          const branchIdx = result as number;
          const existing = absorbable.get(branchIdx) ?? [];
          existing.push(file);
          absorbable.set(branchIdx, existing);
          interactiveFiles.add(file);
        }
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
          const isManual = manualFiles.has(file);
          const isPrompted = interactiveFiles.has(file);
          const annotation = isManual
            ? theme.muted(' (manual)')
            : isPrompted
              ? theme.muted(' (interactive)')
              : '';
          ui.info(`  ${file}${annotation}`);
        }
      }
    }

    // Show remaining conflicted/unowned that were not resolved by prompts
    const unresolvedConflicted = conflicted.filter(
      ({ file }) => !interactiveFiles.has(file),
    );
    const unresolvedUnowned = unowned.filter(
      (file) => !interactiveFiles.has(file),
    );

    if (unresolvedConflicted.length > 0) {
      process.stderr.write('\n');
      for (const { file, branches } of unresolvedConflicted) {
        ui.warn(
          `${file} ${theme.muted(`(touched by ${branches.map((b) => theme.branch(b)).join(', ')})`)}`,
        );
      }
    }

    if (unresolvedUnowned.length > 0) {
      process.stderr.write('\n');
      for (const file of unresolvedUnowned) {
        ui.info(`${file} ${theme.muted('(not owned by any stack branch)')}`);
      }
    }

    // Non-interactive hints for unresolved files
    if (!isInteractive && (unresolvedConflicted.length > 0 || unresolvedUnowned.length > 0)) {
      process.stderr.write('\n');

      if (unresolvedConflicted.length > 0) {
        ui.info('hint: Route ambiguous files:');
        for (const { file } of unresolvedConflicted) {
          const owners = ownershipMap.get(file) ?? [];
          const firstOwner = owners[0];
          if (firstOwner !== undefined) {
            const branchName = stack.branches[firstOwner]?.name ?? '???';
            const shortName = branchName.split('/').pop() ?? branchName;
            ui.info(`  st absorb --route ${shortName}:${file}`);
          }
        }
      }

      if (unresolvedUnowned.length > 0) {
        for (const file of unresolvedUnowned) {
          ui.info(`hint: Assign ${file} to a branch:`);
          for (const branch of stack.branches) {
            const shortName = branch.name.split('/').pop() ?? branch.name;
            ui.info(`  st absorb --route ${shortName}:${file}`);
          }
        }
      }

      // Combined example
      const allUnresolved = [
        ...unresolvedConflicted.map(({ file }) => {
          const owners = ownershipMap.get(file) ?? [];
          const firstOwner = owners[0];
          const branchName = firstOwner !== undefined
            ? stack.branches[firstOwner]?.name ?? '???'
            : '???';
          const shortName = branchName.split('/').pop() ?? branchName;
          return `--route ${shortName}:${file}`;
        }),
        ...unresolvedUnowned.map((file) => `--route <BRANCH>:${file}`),
      ];
      if (allUnresolved.length > 1) {
        process.stderr.write('\n');
        ui.info(`hint: Or combine routing in one command:`);
        ui.info(`  st absorb ${allUnresolved.join(' ')}`);
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

    saveSnapshot('absorb');

    // Execute absorption
    process.stderr.write('\n');
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

    // Helper: drop the absorb stash and restore unabsorbed files.
    // Called in finally block to ensure cleanup even on errors/conflicts.
    const cleanupStash = () => {
      // Drop stash by matching SHA (safe if other stashes were created)
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

      // Write back unabsorbed file contents
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
    };

    // Step c: Single bottom-to-top pass — rebase then commit for each branch.
    // This ensures absorb commits are always on top of the restacked chain,
    // avoiding conflicts when branches later in the stack also have absorb commits.
    let branchesCommitted = 0;

    try {
      const worktreeMap = git.worktreeList();
      const sortedBranches = new Set([...absorbable.keys()]);
      const lowestModifiedIndex = Math.min(...sortedBranches);

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
          const rebaseResult = rebaseBranch({
            branch,
            parentRef: parentBranch.name,
            fallbackOldBase: originalTips[parentBranch.name],
            worktreeMap,
          });

          if (rebaseResult.ok) {
            if (branch.tip) oldTips[branch.name] = branch.tip;
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
              `Resolve conflicts, then run ${theme.command('st continue')}.`,
            );
            return 1;
          }
        }

        // --- Commit absorb files to this branch (if any) ---
        const files = absorbable.get(i);
        if (files && files.length > 0) {
          const commitMsg = this.message ?? generateCommitMessage(files, fileContents);
          const gitCwd = worktreePath ?? repoRoot;
          if (!worktreePath) {
            git.checkout(branch.name);
          }
          for (const file of files) {
            const content = fileContents.get(file);
            if (content === null) {
              // File was deleted — remove it
              Bun.spawnSync(['git', 'rm', '-f', file], {
                stdout: 'pipe', stderr: 'pipe', cwd: gitCwd,
              });
            } else if (content) {
              writeFileSync(join(gitCwd, file), content);
            }
          }
          const addFiles = files.filter((f) => fileContents.get(f) !== null);
          if (addFiles.length > 0) {
            Bun.spawnSync(['git', 'add', ...addFiles], {
              stdout: 'pipe', stderr: 'pipe', cwd: gitCwd,
            });
          }
          Bun.spawnSync(['git', 'commit', '-m', commitMsg], {
            stdout: 'pipe', stderr: 'pipe', cwd: gitCwd,
          });
          branch.tip = git.revParse(branch.name, { cwd: gitCwd });
          branchesCommitted++;
          ui.success(`Committed to ${theme.branch(branch.name)}: ${files.join(', ')}`);
        }

        saveState(state);
      }
    } finally {
      // Always return to original branch, drop stash, and restore unabsorbed files
      git.tryRun('checkout', originalBranch);
      cleanupStash();
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
