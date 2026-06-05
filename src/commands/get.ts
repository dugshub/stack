import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import {
  adoptStackChain,
  collectAncestorStacks,
} from '../lib/remote-adopt.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class GetCommand extends Command {
  static override paths = [['stack', 'get'], ['get']];

  static override usage = Command.Usage({
    description: 'Adopt the remote version of the stack — reset local branches to origin',
    examples: [
      ['Adopt remote refs for the current stack', 'st get'],
      ['Preview what would be adopted', 'st get --dry-run'],
      ['Discard divergent local commits too', 'st get --force'],
    ],
  });

  stackName = Option.String('--stack,-s', {
    description: 'Target stack by name',
  });

  force = Option.Boolean('--force', false, {
    description: 'Adopt diverged branches too (discards local-only commits)',
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Classify branches and print the plan without mutating anything',
  });

  async execute(): Promise<number> {
    // Capture the dirty current branch BEFORE entering withCleanWorktreeAsync —
    // the wrapper auto-stashes, so dirtiness is invisible afterwards, and its
    // stash pop happens AFTER any reset.
    const protectBranch = git.isDirty() ? git.currentBranch() : undefined;
    return git.withCleanWorktreeAsync(() => this.executeInner(protectBranch));
  }

  private async executeInner(protectBranch: string | undefined): Promise<number> {
    const state = loadAndRefreshState();

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

    if (!this.dryRun) saveSnapshot('get');

    ui.info('Fetching from origin...');
    git.fetch();

    // Fast-forward each adopted stack's trunk too (consistent with sync), root
    // ancestors first, then the resolved stack. Never in --dry-run.
    if (!this.dryRun) {
      const chain = [...collectAncestorStacks(state, resolvedName), resolvedName];
      const seenTrunks = new Set<string>();
      for (const name of chain) {
        const s = state.stacks[name];
        if (!s || seenTrunks.has(s.trunk)) continue;
        seenTrunks.add(s.trunk);
        if (git.hasRemoteRef(s.trunk)) {
          git.fastForwardLocalBranch(s.trunk, `origin/${s.trunk}`);
        }
      }
    }

    const results = adoptStackChain(state, resolvedName, {
      force: this.force,
      dryRun: this.dryRun,
      protectBranch,
    });

    // Summary + warnings.
    const adoptedCount = results.filter((r) => r.adopted).length;
    const diverged = results.filter((r) => r.classification === 'diverged');
    const dirtyWorktrees = results.filter(
      (r) => r.classification === 'worktree-dirty',
    );

    for (const r of diverged) {
      const attribution =
        r.resolved === false ? ` ${theme.muted(`(stack ${r.stack})`)}` : '';
      // --force only adopts the RESOLVED stack; ancestors need an explicit -s.
      const hint = r.resolved === false
        ? theme.command(`st get -s ${r.stack} --force`)
        : `${theme.command('--force')}`;
      ui.warn(
        `${theme.branch(r.branch)} has local commits not on the remote — kept local.${attribution} ` +
          `Re-run with ${hint} to discard them.`,
      );
    }
    for (const r of dirtyWorktrees) {
      const attribution =
        r.resolved === false ? ` ${theme.muted(`(stack ${r.stack})`)}` : '';
      if (r.branch === protectBranch) {
        ui.warn(
          `${theme.branch(r.branch)} has uncommitted changes — commit or stash them on ${theme.branch(r.branch)}, then re-run.${attribution}`,
        );
      } else {
        const path = git.worktreeList().get(r.branch) ?? '?';
        ui.warn(
          `${theme.branch(r.branch)} is checked out in a dirty worktree (${path}) — skipped.${attribution}`,
        );
      }
    }

    if (this.dryRun) {
      ui.info('Dry run — no changes made.');
      return 0;
    }

    const allNoRemote =
      results.length > 0 &&
      results.every((r) => r.classification === 'no-remote');

    if (adoptedCount > 0) {
      ui.success(`Adopted ${adoptedCount} branch(es) from origin`);
    } else if (allNoRemote) {
      ui.info('No remote refs found — nothing to adopt.');
    } else if (diverged.length === 0 && dirtyWorktrees.length === 0) {
      ui.info('Already up to date.');
    }

    // Operational failure: every requested adoption failed with a git error.
    const requested = results.filter(
      (r) =>
        r.classification === 'behind' ||
        r.classification === 'rewritten' ||
        // --force only attempts diverged branches in the resolved stack —
        // ancestor diverged branches are never attempted, so never "requested".
        (r.classification === 'diverged' && this.force && r.resolved !== false),
    );
    if (requested.length > 0 && requested.every((r) => !r.adopted)) {
      return 1;
    }

    return 0;
  }
}
