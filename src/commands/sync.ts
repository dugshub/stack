import { Command, Option } from 'clipanion';
import { generateComment } from '../lib/comment.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeRebase, rebaseBranch } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { PrStatus } from '../lib/types.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';
import { findActiveJobForStack } from '../server/state.js';

export class SyncCommand extends Command {
  static override paths = [['stack', 'sync'], ['sync']];

  static override usage = Command.Usage({
    description: 'Sync stack: remove merged branches, rebase remaining',
    examples: [['Sync current stack', 'st sync']],
  });

  stackName = Option.String('--stack,-s', {
    description: 'Target stack by name',
  });

  async execute(): Promise<number> {
    const state = loadAndRefreshState();

    // Guard: check if a merge job is active for the current stack
    const currentBranchForGuard = git.tryRun('branch', '--show-current');
    if (currentBranchForGuard.ok) {
      for (const [name, s] of Object.entries(state.stacks)) {
        for (const branch of s.branches) {
          if (branch.name === currentBranchForGuard.stdout) {
            const activeJob = findActiveJobForStack(name);
            if (activeJob) {
              ui.error(
                `A merge job is active for this stack. Use ${theme.command('st merge --status')} to check progress.`,
              );
              return 2;
            }
            break;
          }
        }
      }
    }

    let resolved: Awaited<ReturnType<typeof resolveStack>>;
    try {
      resolved = await resolveStack({ state, explicitName: this.stackName });
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      return 2;
    }

    const { stackName: resolvedName, stack } = resolved;

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

    saveSnapshot('sync');

    // 1. Fetch
    ui.info('Fetching from origin...');
    git.fetch();

    // 2. Auto-convert dependent stack if trunk branch was deleted from remote (parent merged)
    let trunkChanged = false;
    if (stack.dependsOn) {
      if (!git.hasRemoteRef(stack.trunk)) {
        const defaultBranch = git.defaultBranch();
        const oldTrunk = stack.trunk;
        ui.info(
          `Base branch ${theme.branch(oldTrunk)} no longer exists on remote — converting to standalone stack.`,
        );
        stack.trunk = defaultBranch;
        delete stack.dependsOn;
        stack.updated = new Date().toISOString();
        trunkChanged = true;
        saveState(state);
        ui.success(`Stack is now standalone (trunk → ${theme.branch(defaultBranch)})`);
      } else {
        ui.info(`Syncing dependent stack (base: ${theme.branch(stack.trunk)})`);
      }
    }

    // 3. Check which PRs are merged
    const mergedIndices: number[] = [];
    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch || branch.pr == null) continue;
      const prStatus = gh.prView(branch.pr);
      if (prStatus?.state === 'MERGED') {
        mergedIndices.push(i);
      }
    }

    if (mergedIndices.length === 0 && !trunkChanged) {
      // Still refresh statuses even if nothing to sync
      gh.updateMergeReadyStatuses(state.repo, stack.branches, stack.trunk);
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
      delete state.stacks[resolvedName];
      if (state.currentStack === resolvedName) {
        state.currentStack = null;
      }
      saveState(state);
      ui.success(`Stack ${theme.stack(resolvedName)} fully merged and removed.`);
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

    // Rebase remaining branches
    if (stack.branches.length > 0) {
      const oldTips: Record<string, string> = {};
      for (const branch of stack.branches) {
        const tip = branch.tip ?? git.revParse(branch.name);
        oldTips[branch.name] = tip;
      }

      const worktreeMap = git.worktreeList();

      // Rebase first branch onto trunk
      const firstBranch = stack.branches[0];
      if (firstBranch) {
        ui.info(`Rebasing ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}...`);
        const result = rebaseBranch({
          branch: firstBranch,
          parentRef: stack.trunk,
          fallbackOldBase: mergedBranchTip ?? undefined,
          worktreeMap,
        });
        if (result.ok) {
          if (firstBranch.tip) oldTips[firstBranch.name] = firstBranch.tip;
          ui.success(`Rebased ${theme.branch(firstBranch.name)} onto ${theme.branch(stack.trunk)}`);
        } else {
          stack.restackState = {
            fromIndex: -1,
            currentIndex: 0,
            oldTips,
          };
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
            `Resolve conflicts, stage files, then run ${theme.command('st continue')}.`,
          );
          return 1;
        }
      }

      // Cascade rebase subsequent branches
      const cascadeResult = cascadeRebase({
        state,
        stack,
        fromIndex: -1,
        startIndex: 1,
        worktreeMap,
        oldTips,
      });
      if (!cascadeResult.ok) return 1;
    }

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

    // Update merge-ready statuses
    gh.updateMergeReadyStatuses(state.repo, stack.branches, stack.trunk);

    ui.success(
      `Synced stack ${theme.stack(resolvedName)}: removed ${mergedIndices.length} merged, ${stack.branches.length} remaining`,
    );
    return 0;
  }
}
