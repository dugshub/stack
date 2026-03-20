import { Command, Option } from 'clipanion';
import { descriptionToTitle, parseBranchName } from '../lib/branch.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { findActiveStack, loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class RenameCommand extends Command {
	static override paths = [['branch', 'rename'], ['rename']];

	static override usage = Command.Usage({
		description: 'Rename the current branch in the stack',
		examples: [
			['Rename current branch', 'st rename new-name'],
			['Rename without updating PR title', 'st rename new-name --no-pr-update'],
		],
	});

	newName = Option.String({ required: true, name: 'new-name' });

	noPrUpdate = Option.Boolean('--no-pr-update', false, {
		description: 'Skip updating the PR title',
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();
		const position = findActiveStack(state);

		if (!position) {
			ui.error('Not on a stack branch.');
			return 2;
		}

		const stack = state.stacks[position.stackName];
		if (!stack) {
			ui.error('Stack not found.');
			return 2;
		}

		const branch = stack.branches[position.index];
		if (!branch) {
			ui.error('Could not find current branch.');
			return 2;
		}

		const oldName = branch.name;

		// Parse the old branch name to preserve the user/stack/N- prefix
		const parsed = parseBranchName(oldName);
		let newBranchName: string;
		if (parsed) {
			// Preserve the user/stack/N- prefix, replace the description
			newBranchName = `${parsed.user}/${parsed.stack}/${parsed.index}-${this.newName}`;
		} else {
			// Not a standard branch name — just use the new name as-is
			newBranchName = this.newName;
		}

		if (newBranchName === oldName) {
			ui.info('Branch name unchanged.');
			return 0;
		}

		saveSnapshot('rename');

		// Rename local branch
		const renameResult = git.tryRun('branch', '-m', oldName, newBranchName);
		if (!renameResult.ok) {
			ui.error(`Failed to rename branch: ${renameResult.stderr}`);
			return 2;
		}

		// Push new name to remote
		const pushResult = git.tryRun('push', 'origin', newBranchName);
		if (!pushResult.ok) {
			ui.warn(`Could not push new branch name to remote: ${pushResult.stderr}`);
		}

		// Delete old remote ref
		git.tryRun('push', 'origin', '--delete', oldName);

		// Update state
		branch.name = newBranchName;
		stack.updated = new Date().toISOString();
		saveState(state);

		ui.success(`Renamed ${theme.branch(oldName)} \u2192 ${theme.branch(newBranchName)}`);

		// Update PR title if applicable
		if (branch.pr != null && !this.noPrUpdate) {
			const newParsed = parseBranchName(newBranchName);
			if (newParsed) {
				const newTitle = descriptionToTitle(newParsed.description);
				try {
					gh.prEdit(branch.pr, { title: newTitle });
					ui.info(`Updated PR #${branch.pr} title to "${newTitle}"`);
				} catch (err) {
					ui.warn(`Could not update PR title: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		return 0;
	}
}
