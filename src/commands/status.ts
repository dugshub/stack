import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
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

  json = Option.Boolean('--json', false, {
    description: 'Output as JSON to stdout',
  });

  async execute(): Promise<number> {
    const state = loadAndRefreshState();
    const position = findActiveStack(state);

    if (position) {
      return this.showActiveStack(state, position);
    }
    return this.showAllStacks(state);
  }

  private showActiveStack(
    state: ReturnType<typeof loadState>,
    position: ReturnType<typeof findActiveStack> & object,
  ): number {
    const stack = state.stacks[position.stackName];
    if (!stack) {
      ui.error(`Stack "${position.stackName}" not found in state`);
      return 2;
    }

    // Warn if restack is in progress
    if (stack.restackState) {
      ui.warn(
        `Restack in progress (paused at branch ${stack.restackState.currentIndex + 1}). ` +
          'Resolve conflicts and run `stack restack --continue`, or `stack restack --abort`.',
      );
    }

    // Fetch PR statuses in a single GraphQL call
    const prNumbers = stack.branches
      .map((b) => b.pr)
      .filter((pr): pr is number => pr != null);
    const prStatuses = gh.prViewBatch(prNumbers);

    if (this.json) {
      const output = {
        stackName: position.stackName,
        position: position.index,
        total: position.total,
        trunk: stack.trunk,
        branches: stack.branches.map((b, i) => ({
          ...b,
          position: i + 1,
          isCurrent: i === position.index,
          prStatus: b.pr != null ? (prStatuses.get(b.pr) ?? null) : null,
        })),
        restackState: stack.restackState,
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }

    ui.heading(
      `\nStack: ${theme.stack(position.stackName)} (on branch ${position.index + 1} of ${position.total})\n`,
    );
    ui.stackTree(stack, position, prStatuses);
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

function formatRelativeTime(isoString: string): string {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}
