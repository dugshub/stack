import { Command } from 'clipanion';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import * as git from '../lib/git.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class InitCommand extends Command {
	static override paths = [['init']];

	static override usage = Command.Usage({
		description: 'Install Claude Code skills for stack management into the current project',
		examples: [
			['Install skills into current project', 'stack init'],
		],
	});

	async execute(): Promise<number> {
		// Find project root
		const result = git.tryRun('rev-parse', '--show-toplevel');
		if (!result.ok) {
			ui.error('Not in a git repository.');
			return 2;
		}
		const projectRoot = result.stdout;

		const skillsDir = join(projectRoot, '.claude', 'skills');
		const targets = ['stack', 'stack-management'];

		// Find where the bundled skills live (relative to this source file)
		const cliDir = dirname(dirname(import.meta.dir));
		const bundledSkillsDir = join(cliDir, '.claude', 'skills');

		if (!existsSync(bundledSkillsDir)) {
			// Fallback: try to find skills relative to the resolved package
			ui.error('Could not find bundled skills. Try reinstalling: bun install -g git+ssh://git@github.com/dugshub/stack.git');
			return 2;
		}

		let installed = 0;
		let skipped = 0;

		for (const skill of targets) {
			const srcDir = join(bundledSkillsDir, skill);
			const destDir = join(skillsDir, skill);
			const srcFile = join(srcDir, 'SKILL.md');
			const destFile = join(destDir, 'SKILL.md');

			if (!existsSync(srcFile)) {
				ui.warn(`Bundled skill ${theme.accent(skill)} not found at ${srcFile}`);
				continue;
			}

			if (existsSync(destFile)) {
				ui.info(`${theme.accent(skill)} already installed, updating...`);
			}

			mkdirSync(destDir, { recursive: true });
			copyFileSync(srcFile, destFile);
			ui.success(`Installed ${theme.accent(skill)} skill`);
			installed++;
		}

		if (installed > 0) {
			process.stderr.write('\n');
			ui.success(`Installed ${installed} skill(s) into ${theme.muted(join('.claude', 'skills', '/'))}`);
			ui.info('Claude Code will now have stack awareness in this project.');
		}

		return 0;
	}
}
