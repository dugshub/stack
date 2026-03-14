import { Command } from 'clipanion';
import { generateComment } from '../lib/comment.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { PrStatus, RestackState } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class SyncCommand extends Command {
  static override paths = [['sync']];

  static override usage = Command.Usage({
    description: 'Sync stack: remove merged branches, rebase remaining',
    examples: [['Sync current stack', 'stack sync']],
  });

  async execute(): Promise<number> {
    const state = loadState();

    // Find a stack that the user might be on, or the only stack
    let stackName: string | undefined;
    const currentBranch = git.currentBranch();

    for (const [name, stack] of Object.entries(state.stacks)) {
      for (const branch of stack.branches) {
        if (branch.name === currentBranch) {
          stackName = name;
          break;
        }
      }
      if (stackName) break;
    }

    if (!stackName) {
      // Fallback: if exactly one stack, use it
      const names = Object.keys(state.stacks);
      if (names.length === 1) {
        stackName = names[0];
      }
    }

    if (!stackName) {
      ui.error(
        'Could not determine which stack to sync. Navigate to a stack branch first.',
      );
      return 2;
    }

    const stack = state.stacks[stackName];
    if (!stack) {
      ui.error(`Stack "${stackName}" not found`);
      return 2;
    }

    if (stack.restackState) {
      ui.error(
        'A restack is in progress. Finish it first with --continue or --abort.',
      );
      return 2;
    }

    // Check for dirty working tree before any rebase operations
    if (git.isDirty()) {
      ui.error(
        'Working tree is dirty. Commit or stash changes before syncing.',
      );
      return 2;
    }

    // 1. Fetch
    ui.info('Fetching from origin...');
    git.fetch();

    // 2. Check which PRs are merged
    const mergedIndices: number[] = [];
    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch || branch.pr == null) continue;
      const prStatus = gh.prView(branch.pr);
      if (prStatus?.state === 'MERGED') {
        mergedIndices.push(i);
      }
    }

    if (mergedIndices.length === 0) {
      ui.info('Nothing to sync — no merged PRs.');
      return 0;
    }

    ui.info(`Found ${mergedIndices.length} merged PR(s).`);

    // Check if ALL are merged
    const allMerged = mergedIndices.length === stack.branches.length;

    // 3. Pass 1: Retarget ALL unmerged branches' PRs to their new parent (before deletions!)
    if (!allMerged) {
      const mergedSet = new Set(mergedIndices);

      // Check for non-contiguous merges
      const hasNonContiguous = mergedIndices.some((idx, i) => {
        if (i === 0) return false;
        const prev = mergedIndices[i - 1];
        return prev !== undefined && idx - prev > 1;
      });
      if (hasNonContiguous) {
        ui.warn(
          'Non-contiguous merges detected — some intermediate branches are unmerged. Retargeting all PRs.',
        );
      }

      // For each unmerged branch, figure out its new parent after merged branches are removed
      for (let i = 0; i < stack.branches.length; i++) {
        if (mergedSet.has(i)) continue;
        const branch = stack.branches[i];
        if (!branch || branch.pr == null) continue;

        // New parent = closest non-merged branch below, or trunk if none
        let newBase = stack.trunk;
        for (let j = i - 1; j >= 0; j--) {
          if (!mergedSet.has(j)) {
            const parentBranch = stack.branches[j];
            if (parentBranch) {
              newBase = parentBranch.name;
            }
            break;
          }
        }

        ui.info(`Retargeting ${theme.pr(`#${branch.pr}`)} to ${theme.branch(newBase)}...`);
        try {
          gh.prEdit(branch.pr, { base: newBase });
          ui.success(`Retargeted ${theme.pr(`#${branch.pr}`)} to ${theme.branch(newBase)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.error(`Failed to retarget ${theme.pr(`#${branch.pr}`)}: ${msg}`);
          return 2;
        }
      }
    }

    // 4. Capture the tip of the highest merged branch below the first remaining branch
    //    This is the exclusion point for rebase --onto after squash-merge
    const mergedSet = new Set(mergedIndices);
    let mergedBranchTip: string | null = null;
    if (!allMerged) {
      // Find the first remaining (unmerged) branch index
      const firstRemainingIdx = stack.branches.findIndex(
        (_, i) => !mergedSet.has(i),
      );
      // Walk backwards from it to find the nearest merged branch's tip
      for (let j = firstRemainingIdx - 1; j >= 0; j--) {
        if (mergedSet.has(j)) {
          const mb = stack.branches[j];
          if (mb?.tip) {
            mergedBranchTip = mb.tip;
          } else if (mb) {
            // Fallback: resolve from ref if tip wasn't stored
            const parsed = git.tryRun('rev-parse', mb.name);
            if (parsed.ok) mergedBranchTip = parsed.stdout;
          }
          break;
        }
      }
    }

    // 5. Delete all merged branches (remote + local)
    // Sort descending so indices remain valid as we splice
    const sortedMerged = [...mergedIndices].sort((a, b) => b - a);
    for (const idx of sortedMerged) {
      const branch = stack.branches[idx];
      if (!branch) continue;
      ui.info(`Deleting merged branch ${theme.branch(branch.name)}...`);
      git.deleteBranch(branch.name, { remote: true });
      stack.branches.splice(idx, 1);
    }
    saveState(state);

    // 5. If all merged, remove stack entry
    if (allMerged) {
      delete state.stacks[stackName];
      saveState(state);
      ui.success(`Stack ${theme.stack(stackName)} fully merged and removed.`);
      return 0;
    }

    // 6. Rebase remaining onto updated trunk
    ui.info('Rebasing remaining branches onto trunk...');

    // Update trunk reference
    try {
      git.run('checkout', stack.trunk);
      const ffResult = git.tryRun(
        'merge',
        '--ff-only',
        `origin/${stack.trunk}`,
      );
      if (!ffResult.ok) {
        ui.warn(
          `Could not fast-forward ${theme.branch(stack.trunk)} — trunk may be out of date. Rebases will use the local trunk state.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(`Failed to checkout trunk "${stack.trunk}": ${msg}`);
      return 2;
    }

    // Build restack state for remaining branches
    if (stack.branches.length > 0) {
      const oldTips: Record<string, string> = {};
      for (const branch of stack.branches) {
        const tip = branch.tip ?? git.revParse(branch.name);
        oldTips[branch.name] = tip;
      }

      // Rebase first branch onto trunk
      const firstBranch = stack.branches[0];
      if (firstBranch) {
        const oldTip = oldTips[firstBranch.name];
        if (oldTip) {
          // Use the stored tip of the last merged branch as the exclusion point.
          // This correctly skips already-merged commits after squash-merge.
          // Falls back to merge-base only if no merged branch tip was captured.
          let oldBase: string;
          if (mergedBranchTip) {
            oldBase = mergedBranchTip;
          } else {
            const mergeBaseResult = git.tryRun(
              'merge-base',
              firstBranch.name,
              stack.trunk,
            );
            oldBase = mergeBaseResult.ok ? mergeBaseResult.stdout : oldTip;
          }

          const result = git.rebaseOnto(stack.trunk, oldBase, firstBranch.name);
          if (result.ok) {
            firstBranch.tip = git.revParse(firstBranch.name);
            oldTips[firstBranch.name] = firstBranch.tip;
            ui.success(`Rebased ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}`);
          } else {
            // Save restackState for continuation
            const restackState: RestackState = {
              fromIndex: -1,
              currentIndex: 0,
              oldTips,
            };
            stack.restackState = restackState;
            saveState(state);
            ui.error(
              `Conflict rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}`,
            );
            if (result.conflicts.length > 0) {
              ui.info('Conflicting files:');
              for (const file of result.conflicts) {
                ui.info(`  ${file}`);
              }
            }
            ui.info(
              `Resolve conflicts, stage files, then run ${theme.command('stack restack --continue')}.`,
            );
            return 1;
          }
        }
      }

      // Rebase subsequent branches
      for (let i = 1; i < stack.branches.length; i++) {
        const branch = stack.branches[i];
        const parentBranch = stack.branches[i - 1];
        if (!branch || !parentBranch) continue;

        const oldTip = oldTips[parentBranch.name];
        if (!oldTip) continue;

        const result = git.rebaseOnto(parentBranch.name, oldTip, branch.name);
        if (result.ok) {
          branch.tip = git.revParse(branch.name);
          oldTips[branch.name] = branch.tip;
          ui.success(`Rebased ${theme.branch(branch.name)}`);
        } else {
          // Save restackState for continuation
          const restackState: RestackState = {
            fromIndex: -1,
            currentIndex: i,
            oldTips,
          };
          stack.restackState = restackState;
          saveState(state);
          ui.error(`Conflict rebasing ${theme.branch(branch.name)}`);
          if (result.conflicts.length > 0) {
            ui.info('Conflicting files:');
            for (const file of result.conflicts) {
              ui.info(`  ${file}`);
            }
          }
          ui.info(
            `Resolve conflicts, stage files, then run ${theme.command('stack restack --continue')}.`,
          );
          return 1;
        }
      }
    }

    stack.updated = new Date().toISOString();
    saveState(state);

    // 7. Update stack comments on remaining PRs
    ui.info('Updating stack comments...');
    const repoUrl = `https://github.com/${state.repo}`;
    const prStatuses = new Map<number, PrStatus>();
    for (const branch of stack.branches) {
      if (branch.pr != null) {
        const status = gh.prView(branch.pr);
        if (status) {
          prStatuses.set(branch.pr, status);
        }
      }
    }

    for (const branch of stack.branches) {
      if (branch.pr == null) continue;
      const comment = generateComment(stack, branch.pr, prStatuses, repoUrl);
      try {
        gh.prComment(branch.pr, comment);
      } catch {
        // Non-fatal
      }
    }

    // Navigate back to the first remaining branch
    const firstRemaining = stack.branches[0];
    if (firstRemaining) {
      try {
        git.checkout(firstRemaining.name);
      } catch {
        // Non-fatal
      }
    }

    ui.success(
      `Synced stack ${theme.stack(stackName)}: removed ${mergedIndices.length} merged, ${stack.branches.length} remaining`,
    );
    return 0;
  }
}
