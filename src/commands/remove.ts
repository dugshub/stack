import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class RemoveCommand extends Command {
  static override paths = [['remove']];

  static override usage = Command.Usage({
    description: 'Remove a branch from the active stack',
    examples: [
      ['Remove current branch', 'stack remove'],
      ['Remove a specific branch', 'stack remove user/stack/2-feature'],
      ['Also delete the git branch', 'stack remove --branch'],
      ['Also close the PR', 'stack remove --pr'],
    ],
  });

  branchArg = Option.String({ required: false });

  deleteBranch = Option.Boolean('--branch', false, {
    description: 'Also delete the git branch (local + remote)',
  });

  closePr = Option.Boolean('--pr', false, {
    description: 'Also close the PR',
  });

  async execute(): Promise<number> {
    const state = loadState();
    const position = findActiveStack(state);

    if (!position) {
      ui.error(
        `Not on a stack branch. Use ${theme.command('stack status')} to see tracked stacks.`,
      );
      return 2;
    }

    const stackName = position.stackName;
    const stack = state.stacks[stackName];
    if (!stack) {
      ui.error(`Stack "${stackName}" not found.`);
      return 2;
    }

    // Block if restack is in progress
    if (stack.restackState) {
      ui.error(
        'Cannot remove branches while a restack is in progress. ' +
          `Run ${theme.command('stack restack --continue')} or ${theme.command('stack restack --abort')} first.`,
      );
      return 2;
    }

    saveSnapshot('remove');

    // Resolve which branch to remove
    const targetName = this.branchArg ?? git.currentBranch();
    const targetIndex = stack.branches.findIndex(
      (b) => b.name === targetName,
    );

    if (targetIndex === -1) {
      ui.error(
        `Branch "${targetName}" is not in stack ${theme.stack(stackName)}.`,
      );
      return 2;
    }

    const target = stack.branches[targetIndex];
    if (!target) {
      ui.error('Could not resolve target branch.');
      return 2;
    }

    // Retarget downstream PR's base
    const downstream = stack.branches[targetIndex + 1];
    if (downstream?.pr != null) {
      // New parent: previous branch, or trunk if removing the bottom
      const newBase =
        targetIndex > 0
          ? (stack.branches[targetIndex - 1]?.name ?? stack.trunk)
          : stack.trunk;
      try {
        gh.prEdit(downstream.pr, { base: newBase });
        ui.success(
          `Retargeted ${theme.pr(`#${downstream.pr}`)} to ${theme.branch(newBase)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.warn(
          `Failed to retarget ${theme.pr(`#${downstream.pr}`)}: ${msg}`,
        );
      }
    }

    // Close PR if requested
    if (this.closePr && target.pr != null) {
      try {
        gh.prClose(target.pr);
        ui.success(`Closed ${theme.pr(`#${target.pr}`)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.warn(`Failed to close ${theme.pr(`#${target.pr}`)}: ${msg}`);
      }
    }

    // If removing current branch, navigate away first
    const currentBranch = git.currentBranch();
    if (currentBranch === target.name) {
      // Go to adjacent branch or trunk
      const adjacent =
        stack.branches[targetIndex - 1] ??
        stack.branches[targetIndex + 1];
      const checkoutTarget = adjacent?.name ?? stack.trunk;
      git.checkout(checkoutTarget);
      ui.info(`Checked out ${theme.branch(checkoutTarget)}`);
    }

    // Delete git branch if requested
    if (this.deleteBranch) {
      try {
        git.deleteBranch(target.name, { remote: true });
        ui.success(`Deleted branch ${theme.branch(target.name)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.warn(`Failed to delete ${theme.branch(target.name)}: ${msg}`);
      }
    }

    // Remove from state
    stack.branches.splice(targetIndex, 1);
    stack.updated = new Date().toISOString();

    // If stack is now empty, remove it entirely
    if (stack.branches.length === 0) {
      delete state.stacks[stackName];
      saveState(state);
      ui.success(
        `Removed last branch from stack ${theme.stack(stackName)} — stack deleted.`,
      );
      return 0;
    }

    saveState(state);
    ui.success(
      `Removed ${theme.branch(target.name)} from stack ${theme.stack(stackName)} (${stack.branches.length} branches remaining).`,
    );
    return 0;
  }
}
