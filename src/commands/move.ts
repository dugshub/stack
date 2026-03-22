import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeRebase } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class MoveCommand extends Command {
	static override paths = [['branch', 'move'], ['move']];

	static override usage = Command.Usage({
		description: 'Move a branch within the stack',
		examples: [
			['Move toward trunk', 'st move up'],
			['Move away from trunk', 'st move down'],
			['Move to position 3', 'st move 3'],
			['Preview the move', 'st move --dry-run up'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show what would happen without making changes',
	});

	direction = Option.String({ required: true });

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

		const { stackName: resolvedName, stack, position } = resolved;

		if (!position) {
			ui.error('Not on a stack branch. Check out a branch in the stack first.');
			return 2;
		}

		if (stack.restackState) {
			ui.error(
				`Restack in progress. Run ${theme.command('st continue')} or ${theme.command('st abort')} first.`,
			);
			return 2;
		}

		if (stack.branches.length < 2) {
			ui.error('Nothing to move — stack has only one branch.');
			return 2;
		}

		// Parse direction
		const currentIndex = position.index;
		let targetIndex: number;

		if (this.direction === 'up') {
			targetIndex = currentIndex - 1;
		} else if (this.direction === 'down') {
			targetIndex = currentIndex + 1;
		} else {
			const num = Number.parseInt(this.direction, 10);
			if (Number.isNaN(num)) {
				ui.error(
					`Invalid direction "${this.direction}". Use: up, down, or a position number.`,
				);
				return 2;
			}
			// 1-indexed input to 0-indexed
			targetIndex = num - 1;
		}

		// Boundary checks
		if (targetIndex < 0) {
			ui.error('Already at the bottom of the stack.');
			return 2;
		}
		if (targetIndex >= stack.branches.length) {
			ui.error('Already at the top of the stack.');
			return 2;
		}
		if (targetIndex === currentIndex) {
			ui.info('Branch is already at that position.');
			return 0;
		}

		const currentBranch = stack.branches[currentIndex];
		if (!currentBranch) {
			ui.error('Could not resolve current branch.');
			return 2;
		}

		// Dry-run: show before/after
		if (this.dryRun) {
			ui.heading('Current order:');
			for (let i = 0; i < stack.branches.length; i++) {
				const b = stack.branches[i];
				if (!b) continue;
				const marker = i === currentIndex ? ' (moving)' : '';
				ui.info(`  ${i + 1}. ${b.name}${marker}`);
			}

			// Simulate the move
			const simulated = [...stack.branches];
			const [moved] = simulated.splice(currentIndex, 1);
			if (moved) {
				simulated.splice(targetIndex, 0, moved);
			}

			ui.heading('New order:');
			for (let i = 0; i < simulated.length; i++) {
				const b = simulated[i];
				if (!b) continue;
				const wasIndex = stack.branches.indexOf(b);
				const annotation = wasIndex !== i ? ` (was ${wasIndex + 1})` : '';
				ui.info(`  ${i + 1}. ${b.name}${annotation}`);
			}
			return 0;
		}

		saveSnapshot('move');

		// Build oldTips BEFORE mutation
		const oldTips: Record<string, string> = {};
		for (const branch of stack.branches) {
			oldTips[branch.name] = branch.tip ?? git.revParse(branch.name);
		}

		// Array mutation: splice out current, splice into target
		const [moved] = stack.branches.splice(currentIndex, 1);
		if (!moved) {
			ui.error('Could not splice branch.');
			return 2;
		}
		stack.branches.splice(targetIndex, 0, moved);

		// Update PR bases for affected range
		const startIndex = Math.min(currentIndex, targetIndex);
		for (let i = startIndex; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch?.pr) continue;
			const newBase =
				i === 0
					? stack.trunk
					: (stack.branches[i - 1]?.name ?? stack.trunk);
			try {
				gh.prEdit(branch.pr, { base: newBase });
			} catch {
				ui.warn(`Failed to update PR base for #${branch.pr}`);
			}
		}

		// Cascade rebase from the lower of the two positions
		const fromIndex = startIndex - 1;
		const cascadeResult = cascadeRebase({
			state,
			stack,
			fromIndex,
			startIndex,
			worktreeMap: git.worktreeList(),
			oldTips,
		});

		if (!cascadeResult.ok) {
			return 1;
		}

		stack.updated = new Date().toISOString();
		saveState(state);

		ui.success(
			`Moved ${theme.branch(moved.name)} to position ${targetIndex + 1} in stack ${theme.stack(resolvedName)}.`,
		);
		return 0;
	}
}
