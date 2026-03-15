import { Command, Option } from 'clipanion';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';
import { listSnapshots, restoreSnapshot } from '../lib/undo.js';

export class UndoCommand extends Command {
	static override paths = [['undo']];

	static override usage = Command.Usage({
		description: 'Restore stack state to before the last mutating command',
		examples: [
			['Undo the last operation', 'stack undo'],
			['Go back 3 operations', 'stack undo --steps 3'],
			['List available restore points', 'stack undo --list'],
			['Preview without applying', 'stack undo --dry-run'],
		],
	});

	list = Option.Boolean('--list', false, {
		description: 'Show available restore points',
	});

	steps = Option.String('--steps', '1', {
		description: 'How many operations to undo',
	});

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show what would change',
	});

	async execute(): Promise<number> {
		if (this.list) {
			return this.showList();
		}

		const stepsNum = Number.parseInt(this.steps, 10);
		if (Number.isNaN(stepsNum) || stepsNum < 1) {
			ui.error('--steps must be a positive integer.');
			return 2;
		}

		if (this.dryRun) {
			return this.showDryRun(stepsNum);
		}

		return this.doRestore(stepsNum);
	}

	private showList(): number {
		const snapshots = listSnapshots();
		if (snapshots.length === 0) {
			ui.info('No undo history available.');
			return 0;
		}

		ui.heading('Undo history');
		process.stderr.write('\n');

		for (const snap of snapshots) {
			const ago = relativeTime(snap.timestamp);
			const stacks = `${snap.stackCount} stack${snap.stackCount === 1 ? '' : 's'}`;
			const branches = `${snap.branchCount} branch${snap.branchCount === 1 ? '' : 'es'}`;
			process.stderr.write(
				`  ${theme.accent(String(snap.index))}  ${theme.command(snap.command.padEnd(12))} ${theme.muted(ago.padEnd(20))} ${stacks}, ${branches}\n`,
			);
		}

		process.stderr.write(
			`\nRun ${theme.command('stack undo')} to restore the most recent snapshot.\n`,
		);
		return 0;
	}

	private showDryRun(steps: number): number {
		const snapshots = listSnapshots();
		if (snapshots.length === 0) {
			ui.info('No undo history available.');
			return 0;
		}

		const target = snapshots.find((s) => s.index === steps);
		if (!target) {
			ui.error(
				`Not enough history: only ${snapshots.length} snapshot(s) available, but ${steps} requested.`,
			);
			return 2;
		}

		const ago = relativeTime(target.timestamp);
		ui.heading('Dry run — would restore to:');
		process.stderr.write('\n');
		process.stderr.write(
			`  Command: ${theme.command(target.command)}\n`,
		);
		process.stderr.write(`  When:    ${theme.muted(ago)}\n`);
		process.stderr.write(
			`  Stacks:  ${target.stackCount}, Branches: ${target.branchCount}\n`,
		);
		process.stderr.write(
			`\nNo changes made. Remove ${theme.command('--dry-run')} to apply.\n`,
		);
		return 0;
	}

	private doRestore(steps: number): number {
		try {
			const result = restoreSnapshot(steps);

			ui.success(`Restored to ${steps} operation(s) ago.`);

			if (result.branchesReset.length > 0) {
				ui.info(
					`  Reset: ${result.branchesReset.map((b) => theme.branch(b)).join(', ')}`,
				);
			}
			if (result.branchesCreated.length > 0) {
				ui.info(
					`  Recreated: ${result.branchesCreated.map((b) => theme.branch(b)).join(', ')}`,
				);
			}
			if (result.branchesOrphaned.length > 0) {
				ui.info(
					`  Orphaned (not in snapshot): ${result.branchesOrphaned.map((b) => theme.branch(b)).join(', ')}`,
				);
			}

			process.stderr.write(
				`\nRun ${theme.command('stack submit')} to sync with remote.\n`,
			);
			return 0;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ui.error(msg);
			return 2;
		}
	}
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	const now = Date.now();
	const diffSec = Math.floor((now - then) / 1000);

	if (diffSec < 60) return 'just now';
	if (diffSec < 3600) {
		const m = Math.floor(diffSec / 60);
		return `${m} min${m === 1 ? '' : 's'} ago`;
	}
	if (diffSec < 86400) {
		const h = Math.floor(diffSec / 3600);
		return `${h} hour${h === 1 ? '' : 's'} ago`;
	}
	const d = Math.floor(diffSec / 86400);
	return `${d} day${d === 1 ? '' : 's'} ago`;
}
