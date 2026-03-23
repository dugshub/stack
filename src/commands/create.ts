import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import { parseBranchName, toKebabCase, validateStackName } from '../lib/branch.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { Stack } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class CreateCommand extends Command {
  static override paths = [['stack', 'create'], ['create']];

  static override usage = Command.Usage({
    description: 'Create a new stack or adopt existing branches',
    examples: [
      ['Create a new stack', 'st create frozen-column'],
      [
        'Create with first branch description',
        'st create frozen-column --description sticky-header',
      ],
      [
        'Adopt existing branches',
        'st create frozen-column branch1 branch2',
      ],
      [
        'Adopt existing branches (explicit flag)',
        'st create frozen-column --from branch1 --from branch2',
      ],
      ['Auto-detect from current branch', 'st create'],
      [
        'Create a dependent stack from a specific branch',
        'st create cache-invalidation --base user/stack/5-cache-docs -d initial-setup',
      ],
      [
        'Create a dependent stack from current branch',
        'st create cache-invalidation -b . -d initial-setup',
      ],
    ],
  });

  name = Option.String({ required: false });

  description = Option.String('--description,-d', {
    description: 'Description for the first branch (kebab-case)',
  });

  yes = Option.Boolean('--yes,-y', false, {
    description: 'Skip confirmation prompts (non-interactive mode)',
  });

  from = Option.Array('--from', {
    description: 'Existing branches to adopt into the stack',
  });

  base = Option.String('--base,-b', {
    description: 'Base branch to build on (creates a dependent stack). Use "." for current branch.',
  });

  rest = Option.Rest();

  async execute(): Promise<number> {
    // Option.Rest() captures all positional args (including the name slot).
    // Shift the first rest arg into name when clipanion didn't populate it.
    if (!this.name && this.rest.length > 0) {
      this.name = this.rest.shift();
    }

    // Merge remaining positional rest args into --from
    if (this.rest.length > 0) {
      this.from = [...(this.from ?? []), ...this.rest];
    }

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
    name = toKebabCase(name);
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
      if (this.yes || !process.stdin.isTTY) {
        ui.error('--description is required in non-interactive mode');
        return 2;
      }
      const result = await p.text({
        message: 'First branch description (kebab-case)',
        placeholder: 'e.g. sticky-header',
        validate: (value: string | undefined) => {
          if (!value || value.length === 0)
            return 'Description cannot be empty';
          return undefined;
        },
      });
      if (p.isCancel(result)) {
        ui.info('Cancelled.');
        return 0;
      }
      desc = result;
    }

    desc = toKebabCase(desc);
    if (desc.length === 0) {
      ui.error('Description resolves to empty after normalization');
      return 2;
    }

    const user = gh.currentUser();
    const branchName = `${user}/${name}/1-${desc}`;

    // Resolve --base flag for dependent stack
    const baseResult = this.resolveBase(state);
    if (baseResult.error) {
      ui.error(baseResult.error);
      return 2;
    }

    const trunk = baseResult.trunk ?? git.defaultBranch();
    const dependsOn = baseResult.dependsOn;

    if (baseResult.baseTip) {
      // Dependent stack: create branch at base tip
      git.branchCreate(branchName, baseResult.baseTip);
      git.checkout(branchName);
    } else {
      git.createBranch(branchName);
    }

    const tip = git.revParse('HEAD');
    const parentTip = git.revParse(trunk);

    // Init stack in state
    if (!state.repo) {
      state.repo = gh.repoFullName();
    }
    const now = new Date().toISOString();
    const stackEntry: Stack = {
      trunk,
      branches: [{ name: branchName, tip, pr: null, parentTip }],
      created: now,
      updated: now,
      restackState: null,
    };
    if (dependsOn) {
      stackEntry.dependsOn = dependsOn;
    }
    state.stacks[name] = stackEntry;
    state.currentStack = name;
    saveState(state);

    ui.success(`Created stack ${theme.stack(name)} with branch ${theme.branch(branchName)}`);
    if (dependsOn) {
      ui.info(`  Depends on: ${theme.stack(dependsOn.stack)} (${theme.branch(dependsOn.branch)})`);
    }

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
    if (this.base) {
      ui.warn('--base requires a stack name. Usage: stack create <name> --base <branch>');
      return 2;
    }

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

    if (!this.yes && process.stdin.isTTY) {
      const confirmed = await p.confirm({
        message: `Create stack "${suggestedName}" with current branch "${currentBranch}"?`,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        ui.info('Cancelled.');
        return 0;
      }
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
    const trunk = git.defaultBranch();
    const parentTip = git.revParse(trunk);

    if (!state.repo) {
      state.repo = gh.repoFullName();
    }
    const now = new Date().toISOString();
    state.stacks[suggestedName] = {
      trunk,
      branches: [{ name: currentBranch, tip, pr, parentTip }],
      created: now,
      updated: now,
      restackState: null,
    };
    state.currentStack = suggestedName;
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

    // Resolve --base flag for dependent stack
    const baseResult = this.resolveBase(state);
    if (baseResult.error) {
      ui.error(baseResult.error);
      return 2;
    }

    // Build branch entries
    const trunk = baseResult.trunk ?? git.defaultBranch();
    const dependsOn = baseResult.dependsOn;

    const branchEntries = branches.map((branch, i) => {
      const tip = git.revParse(branch);
      const pr = gh.prList(branch);
      const parentRef = i === 0 ? trunk : branches[i - 1];
      const mb = parentRef ? git.tryRun('merge-base', parentRef, branch) : null;
      const parentTip = mb?.ok ? mb.stdout : null;
      return { name: branch, tip, pr, parentTip };
    });

    if (!state.repo) {
      state.repo = gh.repoFullName();
    }
    const now = new Date().toISOString();
    const stackEntry: Stack = {
      trunk,
      branches: branchEntries,
      created: now,
      updated: now,
      restackState: null,
    };
    if (dependsOn) {
      stackEntry.dependsOn = dependsOn;
    }
    state.stacks[name] = stackEntry;
    state.currentStack = name;
    saveState(state);

    ui.success(`Created stack ${theme.stack(name)} with ${branches.length} branches`);
    if (dependsOn) {
      ui.info(`  Depends on: ${theme.stack(dependsOn.stack)} (${theme.branch(dependsOn.branch)})`);
    }
    for (let i = 0; i < branchEntries.length; i++) {
      const entry = branchEntries[i];
      if (!entry) continue;
      const prStr = entry.pr != null ? ` (${theme.pr(`#${entry.pr}`)})` : '';
      ui.info(`  ${i + 1}. ${theme.branch(entry.name)}${prStr}`);
    }
    return 0;
  }

  private resolveBase(state: ReturnType<typeof loadState>): {
    trunk?: string;
    baseTip?: string;
    dependsOn?: { stack: string; branch: string };
    error?: string;
  } {
    if (!this.base) {
      return {};
    }

    // Resolve "." to current branch
    const baseBranch = this.base === '.' ? git.currentBranch() : this.base;

    // Validate base branch exists
    const verifyResult = git.tryRun('rev-parse', '--verify', baseBranch);
    if (!verifyResult.ok) {
      return { error: `Base branch "${baseBranch}" does not exist` };
    }

    const baseTip = git.revParse(baseBranch);

    // Scan all stacks to find which stack owns the base branch
    let dependsOn: { stack: string; branch: string } | undefined;
    for (const [stackName, stack] of Object.entries(state.stacks)) {
      for (const branch of stack.branches) {
        if (branch.name === baseBranch) {
          dependsOn = { stack: stackName, branch: baseBranch };
          break;
        }
      }
      if (dependsOn) break;
    }

    return {
      trunk: baseBranch,
      baseTip,
      dependsOn,
    };
  }
}
