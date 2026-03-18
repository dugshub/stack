import { Command, Option } from 'clipanion';
import { tryDaemonCache } from '../lib/daemon-client.js';
import { formatRelativeTime } from '../lib/format.js';
import * as gh from '../lib/gh.js';
import { getHint } from '../lib/hints.js';
import { resolveStack, type ResolvedStack } from '../lib/resolve.js';
import { findActiveStack, loadAndRefreshState, loadState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class StatusCommand extends Command {
  static override paths = [['status']];

  static override usage = Command.Usage({
    description: 'Show current stack status',
    examples: [
      ['Show status of current stack', 'stack status'],
      ['Output as JSON', 'stack status --json'],
    ],
  });

  stackName = Option.String('--stack,-s', {
    description: 'Target stack by name',
  });

  json = Option.Boolean('--json', false, {
    description: 'Output as JSON to stdout',
  });

  async execute(): Promise<number> {
    const state = loadAndRefreshState();

    if (this.stackName) {
      let resolved: ResolvedStack;
      try {
        resolved = await resolveStack({ state, explicitName: this.stackName });
      } catch (err) {
        ui.error(err instanceof Error ? err.message : String(err));
        return 2;
      }
      return await this.showActiveStack(state, resolved);
    }

    // No flag: preserve dual-mode behavior
    const position = findActiveStack(state);
    if (position) {
      const stack = state.stacks[position.stackName];
      if (!stack) {
        ui.error(`Stack "${position.stackName}" not found in state`);
        return 2;
      }
      return await this.showActiveStack(state, { stackName: position.stackName, stack, position });
    }
    return this.showAllStacks(state);
  }

  private async showActiveStack(
    _state: ReturnType<typeof loadState>,
    resolved: ResolvedStack,
  ): Promise<number> {
    const { stackName: resolvedName, stack, position } = resolved;
    if (!stack) {
      ui.error(`Stack "${resolvedName}" not found in state`);
      return 2;
    }

    // Warn if restack is in progress
    if (stack.restackState) {
      ui.warn(
        `Restack in progress (paused at branch ${stack.restackState.currentIndex + 1}). ` +
          'Resolve conflicts and run `stack continue`, or `stack abort`.',
      );
    }

    // Fetch PR statuses — try daemon cache first, fall back to GitHub API
    const prNumbers = stack.branches
      .map((b) => b.pr)
      .filter((pr): pr is number => pr != null);

    const state = _state;
    const fullName = state.repo || gh.repoFullName();
    const [owner, repoName] = fullName.split('/');
    let prStatuses = owner && repoName
      ? await tryDaemonCache(owner, repoName)
      : null;
    if (!prStatuses) {
      prStatuses = gh.prViewBatch(prNumbers);
    }

    if (this.json) {
      const output: Record<string, unknown> = {
        stackName: resolvedName,
        position: position?.index ?? null,
        total: stack.branches.length,
        trunk: stack.trunk,
        branches: stack.branches.map((b, i) => ({
          ...b,
          position: i + 1,
          isCurrent: position ? i === position.index : false,
          prStatus: b.pr != null ? (prStatuses.get(b.pr) ?? null) : null,
        })),
        restackState: stack.restackState,
      };
      if (stack.dependsOn) {
        output.dependsOn = stack.dependsOn;
      }
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }

    if (position) {
      ui.heading(
        `\nStack: ${theme.stack(resolvedName)} (on branch ${position.index + 1} of ${position.total})\n`,
      );
      ui.stackTree(stack, position, prStatuses);
    } else {
      ui.heading(
        `\nStack: ${theme.stack(resolvedName)} (${stack.branches.length} branches)\n`,
      );
      // Show tree with a synthetic position that highlights nothing
      const noPosition = {
        stackName: resolvedName,
        index: -1,
        total: stack.branches.length,
        branch: stack.branches[0]!,
        isTop: false,
        isBottom: false,
      };
      ui.stackTree(stack, noPosition, prStatuses);
    }
    const hint = getHint(stack, prStatuses);
    if (hint) {
      process.stderr.write(`\n  ${theme.muted('→')} ${theme.muted(hint)}\n`);
    }
    process.stderr.write('\n');
    return 0;
  }

  private showAllStacks(state: ReturnType<typeof loadState>): number {
    const stackNames = Object.keys(state.stacks);

    if (stackNames.length === 0) {
      ui.info(`No tracked stacks. Use ${theme.command('stack create <name>')} to start one.`);
      return 0;
    }

    if (this.json) {
      const output = Object.entries(state.stacks).map(([name, stack]) => ({
        name,
        branchCount: stack.branches.length,
        trunk: stack.trunk,
        ...(stack.dependsOn ? { dependsOn: stack.dependsOn } : {}),
        updated: stack.updated,
        restackInProgress: stack.restackState !== null,
      }));
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }

    ui.heading('\nTracked stacks:\n');
    for (const name of stackNames) {
      const stack = state.stacks[name];
      if (!stack) continue;
      const age = formatRelativeTime(stack.updated);
      const restackMarker = stack.restackState ? '  (restack in progress)' : '';
      ui.info(
        `  ${theme.stack(name)}   ${stack.branches.length} branches   updated ${age}${restackMarker}`,
      );
    }
    process.stderr.write('\n');
    return 0;
  }
}

