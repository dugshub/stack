import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { PrStatus } from '../lib/types.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class DeleteCommand extends Command {
  static override paths = [['delete']];

  static override usage = Command.Usage({
    description: 'Remove a stack from tracking',
    examples: [
      ['Remove tracking only', 'stack delete my-stack'],
      ['Also delete git branches', 'stack delete my-stack --branches'],
      ['Also close open PRs', 'stack delete my-stack --prs'],
      ['Delete everything', 'stack delete my-stack --branches --prs'],
    ],
  });

  name = Option.String({ required: false });

  branches = Option.Boolean('--branches', false, {
    description: 'Also delete git branches (local + remote)',
  });

  prs = Option.Boolean('--prs', false, {
    description: 'Also close open PRs',
  });

  async execute(): Promise<number> {
    const state = loadAndRefreshState();

    let resolved: Awaited<ReturnType<typeof resolveStack>>;
    try {
      resolved = await resolveStack({
        state,
        explicitName: this.name,
        interactive: this.name ? false : undefined,
      });
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      return 2;
    }

    const { stackName, stack } = resolved;

    // Warn if other stacks depend on this one
    const dependentStacks = Object.entries(state.stacks)
      .filter(([, s]) => s.dependsOn?.stack === stackName)
      .map(([name]) => name);
    if (dependentStacks.length > 0) {
      ui.warn(
        `${dependentStacks.length} stack(s) depend on "${stackName}": ${dependentStacks.join(', ')}`,
      );
      ui.info('Those stacks will lose their dependency metadata.');
    }

    // Safety: prompt for confirmation if stack has open PRs
    const prNumbers = stack.branches
      .map((b) => b.pr)
      .filter((pr): pr is number => pr != null);
    let openPrs: PrStatus[] = [];

    if (prNumbers.length > 0) {
      const prStatuses = gh.prViewBatch(prNumbers);
      openPrs = [...prStatuses.values()].filter((pr) => pr.state === 'OPEN');

      if (openPrs.length > 0) {
        ui.warn(
          `Stack ${theme.stack(stackName)} has ${openPrs.length} open PR(s):`,
        );
        for (const pr of openPrs) {
          ui.info(`  ${theme.pr(`#${pr.number}`)} ${pr.title}`);
        }
        const confirmed = await p.confirm({
          message: `Delete stack "${stackName}"?`,
        });
        if (p.isCancel(confirmed) || !confirmed) {
          ui.info('Cancelled.');
          return 0;
        }
      }
    }

    saveSnapshot('delete');

    // Close PRs if requested
    if (this.prs && openPrs.length > 0) {
      for (const pr of openPrs) {
        try {
          gh.prClose(pr.number);
          ui.success(`Closed ${theme.pr(`#${pr.number}`)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.warn(`Failed to close ${theme.pr(`#${pr.number}`)}: ${msg}`);
        }
      }
    }

    // Delete branches if requested
    if (this.branches) {
      // If we're on a stack branch, move to trunk first
      const currentBranch = git.currentBranch();
      const onStackBranch = stack.branches.some(
        (b) => b.name === currentBranch,
      );
      if (onStackBranch) {
        git.checkout(stack.trunk);
        ui.info(`Checked out ${theme.branch(stack.trunk)}`);
      }

      for (const branch of stack.branches) {
        try {
          git.deleteBranch(branch.name, { remote: true });
          ui.success(`Deleted branch ${theme.branch(branch.name)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.warn(`Failed to delete ${theme.branch(branch.name)}: ${msg}`);
        }
      }
    }

    // Remove from state
    delete state.stacks[stackName];
    if (state.currentStack === stackName) {
      state.currentStack = null;
    }
    saveState(state);

    ui.success(`Removed stack ${theme.stack(stackName)} from tracking.`);
    return 0;
  }
}
