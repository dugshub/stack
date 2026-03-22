import { Command, Option } from 'clipanion';
import { showDashboard } from '../lib/dashboard.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class DefaultCommand extends Command {
	static override paths = [Command.Default];

	name = Option.String({ required: false });

	async execute(): Promise<number> {
		if (!this.name) {
			const result = await showDashboard();
			if (result !== null) return result;
			// No stacks — show basic info
			ui.info('No stacks found. Use `st create <name>` to start one.');
			return 0;
		}

		const state = loadAndRefreshState();
		const stack = state.stacks[this.name];
		if (!stack) {
			ui.error(`Unknown command or stack "${this.name}".`);
			return 2;
		}

		// Skip checkout if already on a branch in this stack
		const position = findActiveStack(state);
		if (position && position.stackName === this.name) {
			state.currentStack = this.name;
			saveState(state);
			ui.info(`Already on stack ${theme.stack(this.name)}`);
			ui.positionReport(position);
			return 0;
		}

		const target = stack.branches[0];
		if (!target) {
			ui.error('Stack has no branches.');
			return 2;
		}

		// Auto-stash for checkout
		const wasDirty = git.isDirty();
		if (wasDirty) git.stashPush({ includeUntracked: true, message: 'stack-auto-stash' });
		git.checkout(target.name);
		if (wasDirty) {
			const pop = git.tryRun('stash', 'pop');
			if (!pop.ok) {
				process.stderr.write(`\x1b[33m⚠\x1b[0m Auto-stash pop failed — your changes are in \`git stash\`.\n`);
			}
		}
		state.currentStack = this.name;
		saveState(state);

		ui.success(`Switched to stack ${theme.stack(this.name)}`);
		ui.positionReport({
			stackName: this.name,
			index: 0,
			total: stack.branches.length,
			branch: target,
			isTop: stack.branches.length === 1,
			isBottom: true,
		});
		return 0;
	}
}
