import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { StackPosition } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class TopCommand extends Command {
	static override paths = [['top']];
	static override usage = Command.Usage({
		description: 'Jump to top of stack',
		examples: [['Jump to top of stack', 'stack top']],
	});

	stackName = Option.String('--stack,-s', { description: 'Target stack by name' });

	async execute(): Promise<number> {
		const state = loadAndRefreshState();
		let resolved;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackName });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName: resolvedName, stack, position: rawPosition } = resolved;
		const positionWasSynthesized = rawPosition === null;
		const position: StackPosition = rawPosition ?? {
			stackName: resolvedName,
			index: 0,
			total: stack.branches.length,
			branch: stack.branches[0]!,
			isTop: stack.branches.length === 1,
			isBottom: true,
		};

		if (!positionWasSynthesized && position.isTop) {
			ui.info('Already at top of stack.');
			return 0;
		}

		const targetIndex = stack.branches.length - 1;
		const target = stack.branches[targetIndex];
		if (!target) {
			ui.error('Could not find target branch');
			return 2;
		}

		git.checkout(target.name);
		ui.success(`Checked out ${theme.branch(target.name)}`);
		ui.positionReport({
			stackName: position.stackName,
			index: targetIndex,
			total: position.total,
			branch: target,
			isTop: true,
			isBottom: targetIndex === 0,
		});
		return 0;
	}
}
