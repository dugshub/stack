import { Command } from 'clipanion';
import * as ui from '../lib/ui.js';

const REPO = 'git+ssh://git@github.com/dugshub/stack.git';

export class UpdateCommand extends Command {
  static override paths = [['update']];

  static override usage = Command.Usage({
    description: 'Update stack to the latest version from GitHub',
  });

  async execute(): Promise<number> {
    ui.info('Updating stack...');
    const result = Bun.spawnSync(['bun', 'install', '-g', REPO], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) {
      ui.error('Update failed');
      return 1;
    }
    ui.success('Updated to latest version');
    return 0;
  }
}
