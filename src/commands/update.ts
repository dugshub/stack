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
		// 0. Record current version before updating
		const oldVersion = this.getInstalledVersion();

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
		const newVersion = this.getInstalledVersion();
		ui.success(`Updated to ${newVersion ?? 'latest'}`);

		// 5. Show changelog
		this.showChangelog(oldVersion, newVersion);

		// 6. Restart daemon if running (so it picks up new code)
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

	private getInstalledVersion(): string | null {
		try {
			const pkgPath = join(GLOBAL_DIR, 'node_modules', '@pattern-stack', 'stack', 'package.json');
			const raw = readFileSync(pkgPath, 'utf-8');
			return JSON.parse(raw).version ?? null;
		} catch {
			return null;
		}
	}

	private showChangelog(oldVersion: string | null, newVersion: string | null): void {
		try {
			const changelogPath = join(GLOBAL_DIR, 'node_modules', '@pattern-stack', 'stack', 'CHANGELOG.md');
			if (!existsSync(changelogPath)) return;
			const content = readFileSync(changelogPath, 'utf-8');

			// Parse version sections
			const sections = content.split(/^## /m).slice(1);
			const relevant: string[] = [];
			for (const section of sections) {
				const ver = section.split('\n')[0]?.trim();
				if (!ver) continue;
				if (oldVersion && ver === oldVersion) break;
				relevant.push(section.trim());
			}

			if (relevant.length === 0) return;

			console.log('');
			console.log('  \x1b[1mWhat\'s new:\x1b[0m');
			for (const section of relevant) {
				const lines = section.split('\n');
				console.log(`  \x1b[36m${lines[0]}\x1b[0m`);
				for (const line of lines.slice(1)) {
					if (line.trim()) console.log(`  ${line}`);
				}
			}
			console.log('');
		} catch {
			// Non-critical
		}
	}
}
