import { Command } from 'clipanion';
import { theme } from '../lib/theme.js';

export class BranchGroupCommand extends Command {
	static override paths = [['branch']];

	static override usage = Command.Usage({
		description: 'Branch operations',
	});

	async execute(): Promise<number> {
		const cmds = [
			['up / down', 'Navigate up/down'],
			['top / bottom', 'Jump to ends'],
			['nav', 'Interactive picker'],
			['track', 'Add current branch'],
			['remove', 'Remove from stack'],
			['pop', 'Pop, keep changes'],
			['fold', 'Fold into parent'],
			['rename <name>', 'Rename branch'],
			['move <dir>', 'Reposition in stack'],
			['insert', 'Insert new branch'],
			['reorder', 'Reorder branches'],
			['modify', 'Amend and restack'],
			['absorb', 'Route fixes to branches'],
			['split', 'Split into stack'],
		];

		process.stderr.write(`\n  ${theme.label('Branch commands')}\n\n`);
		for (const [cmd, desc] of cmds) {
			process.stderr.write(`    ${theme.command(`st branch ${cmd}`.padEnd(36))} ${theme.muted(desc ?? '')}\n`);
		}
		process.stderr.write(`\n  ${theme.muted('Run st branch <command> -h for details')}\n\n`);
		return 0;
	}
}
