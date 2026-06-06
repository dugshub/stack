import { Command, Option } from 'clipanion';
import { tryDaemonCache } from '../lib/daemon.js';
import { formatRelativeTime } from '../lib/format.js';
import * as gh from '../lib/gh.js';
import { getHint } from '../lib/hints.js';
import {
  type RepoWatchStatus,
  repairRepoWatch,
  repoWatchStatus,
} from '../lib/repo-watch.js';
import { resolveStack, type ResolvedStack } from '../lib/resolve.js';
import { findActiveStack, loadAndRefreshState, loadState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class StatusCommand extends Command {
  static override paths = [['stack', 'status'], ['status']];

  static override usage = Command.Usage({
    description: 'Show current stack status',
    examples: [
      ['Show status of current stack', 'st status'],
      ['Output as JSON', 'st status --json'],
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
          'Resolve conflicts and run `st continue`, or `st abort`.',
      );
    }

    // Fetch PR statuses — try daemon cache first, fall back to GitHub API.
    // Run the repo-watch probe concurrently: it and tryDaemonCache are
    // independent async calls, so we don't pay their latencies serially.
    const prNumbers = stack.branches
      .map((b) => b.pr)
      .filter((pr): pr is number => pr != null);

    const state = _state;
    const fullName = state.repo || gh.repoFullName();
    const [owner, repoName] = fullName.split('/');
    const [cachedStatuses, watch] = await Promise.all([
      (async () =>
        owner && repoName ? await tryDaemonCache(owner, repoName) : null)(),
      repoWatchStatus(state),
    ]);
    let prStatuses = cachedStatuses;
    if (!prStatuses) {
      prStatuses = gh.prViewBatch(prNumbers);
    }

    // Surface (or auto-fix) repo-watch drift / unwatched state. Visually first,
    // right after the restack warning, before the stack tree. Skipped in --json
    // mode (a machine read — the observed state is reported in the JSON field).
    if (!this.json) {
      await this.surfaceRepoWatch(state, watch);
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
        repoWatch: {
          stateSlug: watch.stateSlug,
          remoteSlug: watch.remoteSlug,
          drifted: watch.drifted,
          watched: watch.watched,
        },
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

  /**
   * Warn about (autoWatch off) or silently repair (autoWatch on) repo-watch
   * drift and unwatched state. Auto-fix failures fall back to the warning path.
   */
  private async surfaceRepoWatch(
    state: ReturnType<typeof loadState>,
    watch: RepoWatchStatus,
  ): Promise<void> {
    if (!watch.drifted && watch.watched !== false) return;

    if (state.config?.autoWatch) {
      const repair = await repairRepoWatch(state, watch);
      if (repair.driftFixed) {
        ui.info(`  Auto-watch: updated state.repo → ${repair.slug}`);
      }
      if (repair.registered) {
        ui.info(`  Auto-watch: registered ${repair.slug} with the daemon`);
      }
      if (!repair.failed) return;
      // fall through to warn for whatever couldn't be repaired
    }

    if (watch.drifted) {
      ui.warn(
        `Repo slug drift: state has ${theme.branch(watch.stateSlug ?? '?')} but ` +
          `origin is ${theme.branch(watch.remoteSlug ?? '?')}.`,
      );
      process.stderr.write(
        `  ${theme.muted('→')} ${theme.muted('run `st daemon repo heal`')}\n`,
      );
    }
    if (watch.watched === false) {
      ui.warn('This repo is not watched by the daemon (no merge cascades / status cache).');
      process.stderr.write(
        `  ${theme.muted('→')} ${theme.muted(
          `st daemon repo add ${watch.remoteSlug ?? watch.stateSlug ?? '<slug>'} (or st config --auto-watch)`,
        )}\n`,
      );
    }
  }

  private showAllStacks(state: ReturnType<typeof loadState>): number {
    const stackNames = Object.keys(state.stacks);

    if (stackNames.length === 0) {
      ui.info(`No tracked stacks. Use ${theme.command('st create <name>')} to start one.`);
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

