import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class ReorderCommand extends Command {
	static override paths = [['branch', 'reorder'], ['reorder']];

	static override usage = Command.Usage({
		description: 'Reorder branches in the stack',
		examples: [
			['Reorder branches', 'st reorder 3 1 2 4'],
			['Preview the reorder', 'st reorder --dry-run 3 1 2 4'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show what would happen without making changes',
	});

	positions = Option.Rest();

	async execute(): Promise<number> {
		return git.withCleanWorktreeAsync(() => this.executeInner());
	}

	private async executeInner(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackName });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName: resolvedName, stack } = resolved;

		if (stack.restackState) {
			ui.error(
				`Restack in progress. Run ${theme.command('st continue')} or ${theme.command('st abort')} first.`,
			);
			return 2;
		}

		if (this.positions.length === 0) {
			ui.error(
				'Provide position numbers for the new order. Example: st reorder 3 1 2 4',
			);
			return 2;
		}

		// Parse positions (1-indexed to 0-indexed)
		const indices: number[] = [];
		for (const pos of this.positions) {
			const num = Number.parseInt(pos, 10);
			if (Number.isNaN(num)) {
				ui.error(`Invalid position "${pos}". Use numbers.`);
				return 2;
			}
			indices.push(num - 1);
		}

		// Validate: must be a complete permutation
		if (indices.length !== stack.branches.length) {
			ui.error(
				`Expected ${stack.branches.length} positions, got ${indices.length}. Provide all branch positions.`,
			);
			return 2;
		}

		const sorted = [...indices].sort((a, b) => a - b);
		for (let i = 0; i < sorted.length; i++) {
			if (sorted[i] !== i) {
				ui.error(
					`Invalid permutation. Provide each position from 1 to ${stack.branches.length} exactly once.`,
				);
				return 2;
			}
		}

		// Check if this is a no-op (identity permutation)
		const isIdentity = indices.every((val, idx) => val === idx);
		if (isIdentity) {
			ui.info('Branches are already in that order.');
			return 0;
		}

		// Build new array from permutation
		const newBranches = indices.map((idx) => stack.branches[idx]!);

		// Dry-run: show before/after
		if (this.dryRun) {
			ui.heading('Current order:');
			for (let i = 0; i < stack.branches.length; i++) {
				const b = stack.branches[i];
				if (!b) continue;
				ui.info(`  ${i + 1}. ${b.name}`);
			}

			ui.heading('New order:');
			for (let i = 0; i < newBranches.length; i++) {
				const b = newBranches[i];
				if (!b) continue;
				const wasIndex = stack.branches.indexOf(b);
				const annotation = wasIndex !== i ? ` (was ${wasIndex + 1})` : '';
				ui.info(`  ${i + 1}. ${b.name}${annotation}`);
			}
			return 0;
		}

		saveSnapshot('reorder');

		// Replace branches array
		stack.branches = newBranches;
		stack.updated = new Date().toISOString();
		saveState(state);

		ui.success(
			`Reordered branches in stack ${theme.stack(resolvedName)}.`,
		);
		ui.warn(
			`Branches reordered. Run ${theme.command('st restack')} to rebase, then ${theme.command('st submit')} to update PRs.`,
		);
		return 0;
	}
}
