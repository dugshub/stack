import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import { parseBranchName, validateStackName } from '../lib/branch.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class CreateCommand extends Command {
  static override paths = [['create']];

  static override usage = Command.Usage({
    description: 'Create a new stack or adopt existing branches',
    examples: [
      ['Create a new stack', 'stack create frozen-column'],
      [
        'Create with first branch description',
        'stack create frozen-column --description sticky-header',
      ],
      [
        'Adopt existing branches',
        'stack create frozen-column --from branch1 branch2',
      ],
      ['Auto-detect from current branch', 'stack create'],
    ],
  });

  name = Option.String({ required: false });

  description = Option.String('--description,-d', {
    description: 'Description for the first branch (kebab-case)',
  });

  from = Option.Array('--from', {
    description: 'Existing branches to adopt into the stack',
  });

  async execute(): Promise<number> {
    // Mode 3: Retroactive — --from flag
    if (this.from && this.from.length > 0) {
      if (!this.name) {
        ui.error('Stack name is required when using --from');
        return 2;
      }
      return this.retroactive(this.name, this.from);
    }

    // Mode 2: Auto-detect — no name, on non-trunk branch
    if (!this.name) {
      return this.autoDetect();
    }

    // Mode 1: Explicit
    return this.explicit(this.name);
  }

  private async explicit(name: string): Promise<number> {
    const validation = validateStackName(name);
    if (!validation.valid) {
      ui.error(validation.error ?? 'Invalid stack name');
      return 2;
    }

    const state = loadState();
    if (state.stacks[name]) {
      ui.error(`Stack "${name}" already exists`);
      return 2;
    }

    let desc = this.description;
    if (!desc) {
      const result = await p.text({
        message: 'First branch description (kebab-case)',
        placeholder: 'e.g. sticky-header',
        validate: (value: string | undefined) => {
          if (!value || value.length === 0)
            return 'Description cannot be empty';
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value))
            return 'Must be kebab-case';
          return undefined;
        },
      });
      if (p.isCancel(result)) {
        ui.info('Cancelled.');
        return 0;
      }
      desc = result;
    }

    const user = gh.currentUser();
    const branchName = `${user}/${name}/1-${desc}`;

    git.createBranch(branchName);
    const tip = git.revParse('HEAD');

    // Init stack in state
    if (!state.repo) {
      state.repo = gh.repoFullName();
    }
    const now = new Date().toISOString();
    state.stacks[name] = {
      trunk: git.defaultBranch(),
      branches: [{ name: branchName, tip, pr: null }],
      created: now,
      updated: now,
      restackState: null,
    };
    saveState(state);

    ui.success(`Created stack ${theme.stack(name)} with branch ${theme.branch(branchName)}`);

    // First-time repo settings check
    const settings = gh.repoSettings();
    if (!settings.deleteBranchOnMerge) {
      ui.warn(
        'Repo does not have "delete branch on merge" enabled. ' +
          'Consider enabling it in repo settings for cleaner stack sync.',
      );
    }

    return 0;
  }

  private async autoDetect(): Promise<number> {
    const currentBranch = git.currentBranch();

    // Check if already in a stack
    const state = loadState();
    const position = findActiveStack(state);
    if (position) {
      ui.error(
        `Current branch is already in stack "${position.stackName}" at position ${position.index + 1}.`,
      );
      return 2;
    }

    // Try to parse branch name for a suggested stack name
    const parsed = parseBranchName(currentBranch);
    const suggestedName = parsed?.stack ?? currentBranch.split('/').pop() ?? '';

    const confirmed = await p.confirm({
      message: `Create stack "${suggestedName}" with current branch "${currentBranch}"?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      ui.info('Cancelled.');
      return 0;
    }

    const validation = validateStackName(suggestedName);
    if (!validation.valid) {
      ui.error(
        `Suggested name "${suggestedName}" is invalid: ${validation.error}`,
      );
      return 2;
    }

    if (state.stacks[suggestedName]) {
      ui.error(`Stack "${suggestedName}" already exists`);
      return 2;
    }

    const tip = git.revParse('HEAD');
    const pr = gh.prList(currentBranch);

    if (!state.repo) {
      state.repo = gh.repoFullName();
    }
    const now = new Date().toISOString();
    state.stacks[suggestedName] = {
      trunk: git.defaultBranch(),
      branches: [{ name: currentBranch, tip, pr }],
      created: now,
      updated: now,
      restackState: null,
    };
    saveState(state);

    ui.success(`Created stack ${theme.stack(suggestedName)} with branch ${theme.branch(currentBranch)}`);
    return 0;
  }

  private retroactive(name: string, branches: string[]): number {
    const validation = validateStackName(name);
    if (!validation.valid) {
      ui.error(validation.error ?? 'Invalid stack name');
      return 2;
    }

    const state = loadState();
    if (state.stacks[name]) {
      ui.error(`Stack "${name}" already exists`);
      return 2;
    }

    // Verify all branches exist
    for (const branch of branches) {
      const result = git.tryRun('rev-parse', '--verify', branch);
      if (!result.ok) {
        ui.error(`Branch "${branch}" does not exist`);
        return 2;
      }
    }

    // Verify ancestry chain
    for (let i = 1; i < branches.length; i++) {
      const parent = branches[i - 1];
      const child = branches[i];
      if (!parent || !child) continue;
      if (!git.isAncestor(parent, child)) {
        ui.warn(
          `Branch "${child}" does not descend from "${parent}" — ancestry chain is broken.`,
        );
      }
    }

    // Build branch entries
    const branchEntries = branches.map((branch) => {
      const tip = git.revParse(branch);
      const pr = gh.prList(branch);
      return { name: branch, tip, pr };
    });

    if (!state.repo) {
      state.repo = gh.repoFullName();
    }
    const now = new Date().toISOString();
    state.stacks[name] = {
      trunk: git.defaultBranch(),
      branches: branchEntries,
      created: now,
      updated: now,
      restackState: null,
    };
    saveState(state);

    ui.success(`Created stack ${theme.stack(name)} with ${branches.length} branches`);
    for (let i = 0; i < branchEntries.length; i++) {
      const entry = branchEntries[i];
      if (!entry) continue;
      const prStr = entry.pr != null ? ` (${theme.pr(`#${entry.pr}`)})` : '';
      ui.info(`  ${i + 1}. ${theme.branch(entry.name)}${prStr}`);
    }
    return 0;
  }
}
