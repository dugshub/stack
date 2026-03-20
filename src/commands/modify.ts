import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { cascadeRebase, rebaseBranch } from '../lib/rebase.js';
import { findActiveStack, loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class ModifyCommand extends Command {
	static override paths = [['branch', 'modify'], ['modify']];

	static override usage = Command.Usage({
		description: 'Amend staged changes into the current commit and restack',
		examples: [
			['Amend staged changes and restack', 'st modify'],
			['Stage all changes, amend, and restack', 'st modify -a'],
			['Amend with a new commit message', 'st modify -m "new message"'],
			['Amend without restacking', 'st modify --no-restack'],
		],
	});

	all = Option.Boolean('--all,-a', false, {
		description: 'Stage all changes before amending',
	});

	message = Option.String('--message,-m', {
		description: 'New commit message for the amended commit',
	});

	restack = Option.Boolean('--restack', true, {
		description: 'Restack downstream branches after amending',
	});

	async execute(): Promise<number> {
		const originalBranch = git.currentBranch();

		// Stage all if -a flag
		if (this.all) {
			git.run('add', '-A');
		}

		// Check if anything is staged
		const staged = git.tryRun('diff', '--cached', '--quiet');
		if (staged.ok && !this.message) {
			// Nothing staged and no message change
			ui.error('Nothing to modify. Stage changes first, or use -a to stage all.');
			return 2;
		}

		saveSnapshot('modify');

		// Amend the commit
		const amendArgs = ['commit', '--amend', '--no-edit'];
		if (this.message) {
			// Replace --no-edit with the message
			amendArgs.splice(amendArgs.indexOf('--no-edit'), 1, '-m', this.message);
		}
		const amendResult = git.tryRun(...amendArgs);
		if (!amendResult.ok) {
			ui.error(`Amend failed: ${amendResult.stderr}`);
			return 2;
		}

		ui.success('Amended commit');

		// Find current position in stack
		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		if (!position) {
			// Not in a stack — just amend, no restack needed
			ui.info('Not in a stack — skipping restack.');
			return 0;
		}

		if (!this.restack) {
			ui.info('Skipping restack (--no-restack).');
			return 0;
		}

		if (position.isTop) {
			ui.info('At top of stack — no downstream branches to restack.');
			return 0;
		}

		// Restack downstream branches
		const stack = state.stacks[position.stackName];
		if (!stack) return 0;

		const fromIndex = position.index;

		// Snapshot old tips
		const oldTips: Record<string, string> = {};
		for (let i = fromIndex; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch) continue;
			const tip = branch.tip ?? git.revParse(branch.name);
			oldTips[branch.name] = tip;
		}

		const worktreeMap = git.worktreeList();

		ui.info('Restacking downstream branches...');
		const cascadeResult = cascadeRebase({
			state,
			stack,
			fromIndex,
			startIndex: fromIndex + 1,
			worktreeMap,
			oldTips,
		});

		if (cascadeResult.ok) {
			// Return to the original branch
			git.checkout(originalBranch);
			ui.success(`Restacked ${cascadeResult.rebased} downstream branch(es)`);
		} else {
			ui.error('Restack encountered conflicts.');
			ui.info(`Resolve conflicts, then run ${theme.command('st continue')}.`);
			return 1;
		}

		return 0;
	}
}
