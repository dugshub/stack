import { Command } from 'clipanion';
import { theme } from '../lib/theme.js';

export class StackGroupCommand extends Command {
	static override paths = [['stack']];

	static override usage = Command.Usage({
		description: 'Stack operations',
	});

	async execute(): Promise<number> {
		const cmds = [
			['create <name>', 'Start a new stack'],
			['delete <name>', 'Remove a stack'],
			['status', 'Show stack and PR status'],
			['submit', 'Push branches, create/update PRs'],
			['sync', 'Clean up after merges'],
			['merge', 'Merge entire stack'],
			['restack', 'Rebase downstream branches'],
			['check <cmd>', 'Run command on every branch'],
			['graph', 'Show dependency graph'],
		];

		process.stderr.write(`\n  ${theme.label('Stack commands')}\n\n`);
		for (const [cmd, desc] of cmds) {
			process.stderr.write(`    ${theme.command(`st stack ${cmd}`.padEnd(36))} ${theme.muted(desc ?? '')}\n`);
		}
		process.stderr.write(`\n  ${theme.muted('Run st stack <command> -h for details')}\n\n`);
		return 0;
	}
}
