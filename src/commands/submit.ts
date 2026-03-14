import { Command, Option } from 'clipanion';
import { descriptionToTitle, parseBranchName } from '../lib/branch.js';
import { generateComment } from '../lib/comment.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { PrStatus } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class SubmitCommand extends Command {
  static override paths = [['submit']];

  static override usage = Command.Usage({
    description: 'Push branches and create/update PRs for the stack',
    examples: [
      ['Show what would happen', 'stack submit --dry-run'],
      ['Push and create/update PRs', 'stack submit'],
    ],
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Show what would happen without making changes',
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

    const stack = state.stacks[position.stackName];
    if (!stack) {
      ui.error(`Stack "${position.stackName}" not found`);
      return 2;
    }

    if (this.dryRun) {
      return this.showDryRun(stack, position.stackName);
    }

    return this.fullSubmit(state, stack, position.stackName);
  }

  private showDryRun(
    stack: ReturnType<typeof loadState>['stacks'][string] & object,
    _stackName: string,
  ): number {
    const createCount = stack.branches.filter((b) => b.pr == null).length;
    const updateCount = stack.branches.filter((b) => b.pr != null).length;

    ui.heading(
      `\nWould push ${stack.branches.length} branches and create ${createCount}/update ${updateCount} PRs:\n`,
    );

    process.stderr.write(
      `  ${theme.muted('Branch'.padEnd(50))} ${theme.muted('Base'.padEnd(20))} ${theme.muted('Action')}\n`,
    );
    process.stderr.write(
      `  ${''.padEnd(50, '\u2500')} ${''.padEnd(20, '\u2500')} ${''.padEnd(20, '\u2500')}\n`,
    );

    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch) continue;
      const base =
        i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);
      const action =
        branch.pr != null
          ? theme.accent(`update PR #${branch.pr}`)
          : i === 0
            ? theme.accent('create PR (ready)')
            : theme.accent('create PR (draft)');
      const shortBase = base.length > 18 ? `${base.slice(0, 15)}...` : base;
      process.stderr.write(
        `  ${theme.branch(branch.name.padEnd(50))} ${shortBase.padEnd(20)} ${action}\n`,
      );
    }

    process.stderr.write(`\nRun ${theme.command('stack submit')} to proceed.\n`);
    return 0;
  }

  private fullSubmit(
    state: ReturnType<typeof loadState>,
    stack: ReturnType<typeof loadState>['stacks'][string] & object,
    stackName: string,
  ): number {
    const originalBranch = git.currentBranch();

    // 1. Push all branches (bottom to top)
    ui.heading('\nPushing branches...');
    for (const branch of stack.branches) {
      if (git.hasRemoteRef(branch.name)) {
        // Existing remote branch — force-push with lease
        const pushResult = git.pushForceWithLease('origin', branch.name);
        if (pushResult.ok) {
          ui.success(`Pushed ${theme.branch(branch.name)}`);
        } else {
          ui.error(
            `Push rejected for ${theme.branch(branch.name)}. Someone else may have pushed. Run ${theme.command('git fetch')} and check.`,
          );
          return 2;
        }
      } else {
        // New branch — push with tracking
        try {
          git.pushNew('origin', branch.name);
          ui.success(`Pushed ${theme.branch(branch.name)} (new)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.error(`Failed to push ${theme.branch(branch.name)}: ${msg}`);
          return 2;
        }
      }
      // Update tip
      branch.tip = git.revParse(branch.name);
    }

    // 2. Create/update PRs
    ui.heading('\nCreating/updating PRs...');
    const repoUrl = `https://github.com/${state.repo}`;

    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch) continue;
      const base =
        i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);

      if (branch.pr == null) {
        // Create PR
        const title = this.deriveTitle(branch.name);
        const draft = true;
        try {
          const prNumber = gh.prCreate({
            base,
            head: branch.name,
            title,
            body: '',
            draft,
          });
          branch.pr = prNumber;
          ui.success(
            `Created ${theme.pr(`#${prNumber}`)} for ${theme.branch(branch.name)}${draft ? ' (draft)' : ''}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.error(`Failed to create PR for ${theme.branch(branch.name)}: ${msg}`);
          return 2;
        }
      } else {
        // Update existing PR — verify it exists, update base if needed
        const prStatus = gh.prView(branch.pr);
        if (!prStatus) {
          ui.warn(`${theme.pr(`#${branch.pr}`)} not found — skipping update`);
          continue;
        }
        try {
          gh.prEdit(branch.pr, { base });
          ui.success(`Updated ${theme.pr(`#${branch.pr}`)} base to ${theme.branch(base)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.warn(`Failed to update ${theme.pr(`#${branch.pr}`)} base: ${msg}`);
        }
      }
    }

    // 3. Post stack comments
    ui.heading('\nUpdating stack comments...');
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
        ui.success(`Updated stack comment on ${theme.pr(`#${branch.pr}`)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.warn(`Failed to update comment on ${theme.pr(`#${branch.pr}`)}: ${msg}`);
      }
    }

    // 4. Save state
    stack.updated = new Date().toISOString();
    saveState(state);

    // Restore original branch
    try {
      git.checkout(originalBranch);
    } catch {
      // If we can't restore, that's ok — user can switch manually
    }

    // 5. Report
    process.stderr.write('\n');
    ui.success(`Submitted stack ${theme.stack(stackName)} (${stack.branches.length} PRs)`);
    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch) continue;
      const prStr = branch.pr != null ? theme.pr(`#${branch.pr}`) : 'no PR';
      ui.info(`  ${i + 1}. ${theme.branch(branch.name)} → ${prStr}`);
    }
    return 0;
  }

  private deriveTitle(branchName: string): string {
    const parsed = parseBranchName(branchName);
    if (parsed) {
      return descriptionToTitle(parsed.description);
    }
    // Fallback: last commit subject
    const subjects = git.log(`${branchName}~1..${branchName}`, '%s');
    const subject = subjects[0];
    if (subject) return subject;
    // Last resort: branch name
    return branchName;
  }
}
