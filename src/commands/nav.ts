import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { findActiveStack, loadState } from '../lib/state.js';
import type { Stack, StackPosition } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class NavCommand extends Command {
  static override paths = [['nav']];

  static override usage = Command.Usage({
    description: 'Navigate the stack: up, down, top, bottom',
    examples: [
      ['Move toward trunk', 'stack nav up'],
      ['Move away from trunk', 'stack nav down'],
      ['Go to top of stack', 'stack nav top'],
      ['Go to bottom of stack', 'stack nav bottom'],
    ],
  });

  direction = Option.String({ required: false });

  async execute(): Promise<number> {
    if (!this.direction) {
      return this.showUsage();
    }

    const validDirections = ['up', 'down', 'top', 'bottom'];
    if (!validDirections.includes(this.direction)) {
      ui.error(
        `Invalid direction "${this.direction}". Use: up, down, top, bottom`,
      );
      return 2;
    }

    const state = loadState();
    const position = findActiveStack(state);

    if (!position) {
      ui.error(
        'Not on a stack branch. Use `stack status` to see tracked stacks.',
      );
      return 2;
    }

    const stack = state.stacks[position.stackName];
    if (!stack) {
      ui.error(`Stack "${position.stackName}" not found in state`);
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

  private navUp(stack: Stack, position: StackPosition): number {
    if (position.isBottom) {
      if (process.stdout.isTTY) {
        ui.info(`Already at bottom of stack. Trunk is "${stack.trunk}".`);
        // In a future iteration, could prompt to checkout trunk
        // For now, just inform
        ui.info(`Run \`git checkout ${stack.trunk}\` to switch to trunk.`);
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
    ui.success(`Checked out ${target.name}`);
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
    ui.success(`Checked out ${target.name}`);
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
    ui.success(`Checked out ${target.name}`);
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
    ui.success(`Checked out ${target.name}`);
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

  private showUsage(): number {
    const state = loadState();
    const position = findActiveStack(state);

    if (position) {
      ui.positionReport(position);
      process.stderr.write('\n');
      process.stderr.write('Navigate with:\n');
    } else {
      process.stderr.write('Navigate your stack:\n');
    }

    process.stderr.write('  stack nav up       Move toward trunk\n');
    process.stderr.write('  stack nav down     Move away from trunk\n');
    process.stderr.write('  stack nav top      Go to top of stack\n');
    process.stderr.write('  stack nav bottom   Go to bottom of stack\n');

    if (!position) {
      process.stderr.write('\n');
      process.stderr.write('Not currently on a stack branch.\n');
      process.stderr.write('Use `stack status` to see tracked stacks.\n');
    }

    return 0;
  }
}
