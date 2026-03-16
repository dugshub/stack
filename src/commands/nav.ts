import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadAndRefreshState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { Stack, StackPosition } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class NavCommand extends Command {
  static override paths = [['nav']];

  static override usage = Command.Usage({
    description: 'Navigate the stack: up, down, top, bottom, or interactive',
    examples: [
      ['Interactive branch picker', 'stack nav'],
      ['Jump to branch #3', 'stack nav 3'],
      ['Move toward trunk', 'stack nav up'],
      ['Move away from trunk', 'stack nav down'],
      ['Go to top of stack', 'stack nav top'],
      ['Go to bottom of stack', 'stack nav bottom'],
    ],
  });

  direction = Option.String({ required: false });

  async execute(): Promise<number> {
    if (!this.direction) {
      return this.interactive();
    }

    const state = loadAndRefreshState();
    const position = findActiveStack(state);

    if (!position) {
      ui.error(
        `Not on a stack branch. Use ${theme.command('stack status')} to see tracked stacks.`,
      );
      return 2;
    }

    const stack = state.stacks[position.stackName];
    if (!stack) {
      ui.error(`Stack "${position.stackName}" not found in state`);
      return 2;
    }

    // Numeric navigation: `stack nav 3` → jump to branch #3
    const num = Number.parseInt(this.direction, 10);
    if (!Number.isNaN(num)) {
      return this.navTo(stack, position, num);
    }

    const validDirections = ['up', 'down', 'top', 'bottom'];
    if (!validDirections.includes(this.direction)) {
      ui.error(
        `Invalid direction "${this.direction}". Use: up, down, top, bottom, or a number`,
      );
      return 2;
    }

    switch (this.direction) {
      case 'up':
        return this.navUp(stack, position);
      case 'down':
        return this.navDown(stack, position);
      case 'top':
        return this.navTop(stack, position);
      case 'bottom':
        return this.navBottom(stack, position);
      default:
        return 2;
    }
  }

  private navTo(stack: Stack, position: StackPosition, num: number): number {
    if (num < 1 || num > stack.branches.length) {
      ui.error(
        `Branch number ${num} out of range. Stack has ${stack.branches.length} branch(es).`,
      );
      return 2;
    }

    const targetIndex = num - 1;
    if (targetIndex === position.index) {
      ui.info(`Already on branch ${num}.`);
      return 0;
    }

    const target = stack.branches[targetIndex];
    if (!target) {
      ui.error('Could not find target branch');
      return 2;
    }

    git.checkout(target.name);
    ui.success(`Checked out ${theme.branch(target.name)}`);
    ui.positionReport({
      stackName: position.stackName,
      index: targetIndex,
      total: position.total,
      branch: target,
      isTop: targetIndex === stack.branches.length - 1,
      isBottom: targetIndex === 0,
    });
    return 0;
  }

  private navUp(stack: Stack, position: StackPosition): number {
    if (position.isBottom) {
      if (process.stdout.isTTY) {
        ui.info(`Already at bottom of stack. Trunk is ${theme.branch(stack.trunk)}.`);
        ui.info(`Run ${theme.command(`git checkout ${stack.trunk}`)} to switch to trunk.`);
      }
      return 0;
    }

    const targetIndex = position.index - 1;
    const target = stack.branches[targetIndex];
    if (!target) {
      ui.error('Could not find target branch');
      return 2;
    }

    git.checkout(target.name);
    ui.success(`Checked out ${theme.branch(target.name)}`);
    ui.positionReport({
      stackName: position.stackName,
      index: targetIndex,
      total: position.total,
      branch: target,
      isTop: targetIndex === stack.branches.length - 1,
      isBottom: targetIndex === 0,
    });
    return 0;
  }

  private navDown(stack: Stack, position: StackPosition): number {
    if (position.isTop) {
      ui.info('Already at top of stack.');
      return 0;
    }

    const targetIndex = position.index + 1;
    const target = stack.branches[targetIndex];
    if (!target) {
      ui.error('Could not find target branch');
      return 2;
    }

    git.checkout(target.name);
    ui.success(`Checked out ${theme.branch(target.name)}`);
    ui.positionReport({
      stackName: position.stackName,
      index: targetIndex,
      total: position.total,
      branch: target,
      isTop: targetIndex === stack.branches.length - 1,
      isBottom: targetIndex === 0,
    });
    return 0;
  }

  private navTop(stack: Stack, position: StackPosition): number {
    const targetIndex = stack.branches.length - 1;
    const target = stack.branches[targetIndex];
    if (!target) {
      ui.error('Could not find target branch');
      return 2;
    }

    if (position.isTop) {
      ui.info('Already at top of stack.');
      return 0;
    }

    git.checkout(target.name);
    ui.success(`Checked out ${theme.branch(target.name)}`);
    ui.positionReport({
      stackName: position.stackName,
      index: targetIndex,
      total: position.total,
      branch: target,
      isTop: true,
      isBottom: targetIndex === 0,
    });
    return 0;
  }

  private navBottom(stack: Stack, position: StackPosition): number {
    const target = stack.branches[0];
    if (!target) {
      ui.error('Could not find target branch');
      return 2;
    }

    if (position.isBottom) {
      ui.info('Already at bottom of stack.');
      return 0;
    }

    git.checkout(target.name);
    ui.success(`Checked out ${theme.branch(target.name)}`);
    ui.positionReport({
      stackName: position.stackName,
      index: 0,
      total: position.total,
      branch: target,
      isTop: stack.branches.length === 1,
      isBottom: true,
    });
    return 0;
  }

  private async interactive(): Promise<number> {
    const state = loadAndRefreshState();
    const position = findActiveStack(state);

    if (!position) {
      ui.error(
        `Not on a stack branch. Use ${theme.command('stack status')} to see tracked stacks.`,
      );
      return 2;
    }

    const stack = state.stacks[position.stackName];
    if (!stack) {
      ui.error(`Stack "${position.stackName}" not found in state`);
      return 2;
    }

    // Fetch PR statuses
    const prNumbers = stack.branches
      .map((b) => b.pr)
      .filter((pr): pr is number => pr != null);
    const prStatuses = gh.prViewBatch(prNumbers);

    // Build select options
    const options = stack.branches.map((branch, i) => {
      const pr = branch.pr != null ? prStatuses.get(branch.pr) ?? null : null;
      const emoji = ui.statusEmoji(pr);
      const prStr = branch.pr != null ? ` ${theme.pr(`#${branch.pr}`)}` : '';
      const statusStr = pr ? ` ${emoji} ${ui.statusText(pr)}` : '';
      const marker = i === position.index ? ' \u2190' : '';
      return {
        value: branch.name,
        label: `${i + 1}. ${branch.name}${prStr}${statusStr}${marker}`,
      };
    });

    const selected = await p.select({
      message: `Stack: ${position.stackName}`,
      options,
      initialValue: position.branch.name,
    });

    if (p.isCancel(selected)) {
      return 0;
    }

    const selectedName = selected as string;
    if (selectedName === position.branch.name) {
      ui.info('Already on this branch.');
      return 0;
    }

    git.checkout(selectedName);
    const newIndex = stack.branches.findIndex((b) => b.name === selectedName);
    const target = stack.branches[newIndex];
    if (target) {
      ui.success(`Checked out ${theme.branch(target.name)}`);
      ui.positionReport({
        stackName: position.stackName,
        index: newIndex,
        total: position.total,
        branch: target,
        isTop: newIndex === stack.branches.length - 1,
        isBottom: newIndex === 0,
      });
    }
    return 0;
  }
}
