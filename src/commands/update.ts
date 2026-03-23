import { Command } from 'clipanion';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as ui from '../lib/ui.js';

const REPO = 'git+ssh://git@github.com/dugshub/stack.git';
const GLOBAL_DIR = join(
	process.env.HOME ?? '~',
	'.bun',
	'install',
	'global',
);

export class UpdateCommand extends Command {
	static override paths = [['update']];

	static override usage = Command.Usage({
		description: 'Update stack to the latest version from GitHub',
	});

	async execute(): Promise<number> {
		ui.info('Updating stack...');

		// 1. Clean global package.json to avoid dependency loop
		const pkgPath = join(GLOBAL_DIR, 'package.json');
		try {
			const raw = readFileSync(pkgPath, 'utf-8');
			const pkg = JSON.parse(raw);
			if (pkg.dependencies) {
				delete pkg.dependencies['@pattern-stack/stack'];
				delete pkg.dependencies['@dealbrain/stack'];
				writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
			}
		} catch {
			// If we can't clean it, try the install anyway
		}

		// 2. Delete lockfile so bun fetches the latest commit
		const lockPath = join(GLOBAL_DIR, 'bun.lock');
		try {
			if (existsSync(lockPath)) unlinkSync(lockPath);
		} catch {
			// Non-critical
		}

		// 3. Clear bun's git cache so it fetches the latest ref
		const cacheDir = join(process.env.HOME ?? '~', '.bun', 'install', 'cache');
		try {
			const { readdirSync, rmSync } = require('fs');
			for (const entry of readdirSync(cacheDir)) {
				if (entry.endsWith('.git')) {
					rmSync(join(cacheDir, entry), { recursive: true, force: true });
				}
			}
		} catch {
			// Non-critical
		}

		// 4. Reinstall from GitHub
		const result = Bun.spawnSync(['bun', 'install', '-g', REPO], {
			stdout: 'inherit',
			stderr: 'inherit',
		});
		if (result.exitCode !== 0) {
			ui.error('Update failed');
			return 1;
		}
		ui.success('Updated to latest version');

		// 5. Restart daemon if running (so it picks up new code)
		const { isDaemonRunning, stopDaemon, startDaemon } = await import('../server/lifecycle.js');
		if (isDaemonRunning()) {
			ui.info('Restarting daemon...');
			await stopDaemon();
			await new Promise((r) => setTimeout(r, 500));
			const { pid } = await startDaemon();
			ui.success(`Daemon restarted (pid ${pid})`);
		}

		return 0;
	}
}
