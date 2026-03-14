import { Command } from 'clipanion';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as ui from '../lib/ui.js';

const REPO = 'git+ssh://git@github.com/dugshub/stack.git';
const GLOBAL_PKG = join(
	process.env.HOME ?? '~',
	'.bun',
	'install',
	'global',
	'package.json',
);

export class UpdateCommand extends Command {
	static override paths = [['update']];

	static override usage = Command.Usage({
		description: 'Update stack to the latest version from GitHub',
	});

	async execute(): Promise<number> {
		ui.info('Updating stack...');

		// Clean global package.json to avoid dependency loop
		// (bun adds our package as a dep, but we ARE that package)
		try {
			const raw = readFileSync(GLOBAL_PKG, 'utf-8');
			const pkg = JSON.parse(raw);
			if (pkg.dependencies) {
				delete pkg.dependencies['@pattern-stack/stack'];
				delete pkg.dependencies['@dealbrain/stack'];
				writeFileSync(GLOBAL_PKG, JSON.stringify(pkg, null, 2) + '\n');
			}
		} catch {
			// If we can't clean it, try the install anyway
		}

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
