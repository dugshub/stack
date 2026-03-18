import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import type { Stack, StackPosition } from '../lib/types.js';
import * as ui from '../lib/ui.js';

export class NavCommand extends Command {
	static override paths = [['nav']];

	static override usage = Command.Usage({
		description: 'Interactive branch picker or jump to branch N',
		examples: [
			['Interactive branch picker', 'stack nav'],
			['Jump to branch #3', 'stack nav 3'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	direction = Option.String({ required: false });

	async execute(): Promise<number> {
		if (!this.direction) {
			return this.interactive();
		}

		// Numeric navigation: `stack nav 3` -> jump to branch #3
		const num = Number.parseInt(this.direction, 10);
		if (!Number.isNaN(num)) {
			const state = loadAndRefreshState();

			let resolved: Awaited<ReturnType<typeof resolveStack>>;
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

			return this.navTo(stack, position, num, positionWasSynthesized);
		}

		// Directional words are now top-level commands
		const directions = ['up', 'down', 'top', 'bottom'];
		if (directions.includes(this.direction)) {
			ui.error(`"stack nav ${this.direction}" is no longer supported. Use "stack ${this.direction}" instead.`);
			return 2;
		}

		ui.error(`Invalid argument "${this.direction}". Use a number or run "stack nav" for interactive picker.`);
		return 2;
	}

	private navTo(stack: Stack, position: StackPosition, num: number, positionWasSynthesized: boolean): number {
		if (num < 1 || num > stack.branches.length) {
			ui.error(
				`Branch number ${num} out of range. Stack has ${stack.branches.length} branch(es).`,
			);
			return 2;
		}

		const targetIndex = num - 1;
		if (!positionWasSynthesized && targetIndex === position.index) {
			ui.info(`Already on branch ${num}.`);
			return 0;
		}

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
			isTop: targetIndex === stack.branches.length - 1,
			isBottom: targetIndex === 0,
		});
		return 0;
	}

	private async interactive(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
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

		// Fetch PR statuses
		const prNumbers = stack.branches
			.map((b) => b.pr)
			.filter((pr): pr is number => pr != null);
		const prStatuses = gh.prViewBatch(prNumbers);

		// Build select options
		const options = stack.branches.map((branch, i) => {
			const pr = branch.pr != null ? prStatuses.get(branch.pr) ?? null : null;
			const emoji = ui.statusEmoji(pr);
			const prStr = branch.pr != null ? ` ${theme.pr(`#${branch.pr}`)}` : '';
			const statusStr = pr ? ` ${emoji} ${ui.statusText(pr)}` : '';
			const marker = !positionWasSynthesized && i === position.index ? ' \u2190' : '';
			return {
				value: branch.name,
				label: `${i + 1}. ${branch.name}${prStr}${statusStr}${marker}`,
			};
		});

		const initialValue = positionWasSynthesized
			? stack.branches[0]?.name
			: position.branch.name;

		const selected = await p.select({
			message: `Stack: ${resolvedName}`,
			options,
			initialValue,
		});

		if (p.isCancel(selected)) {
			return 0;
		}

		const selectedName = selected as string;
		if (!positionWasSynthesized && selectedName === position.branch.name) {
			ui.info('Already on this branch.');
			return 0;
		}

		git.checkout(selectedName);
		const newIndex = stack.branches.findIndex((b) => b.name === selectedName);
		const target = stack.branches[newIndex];
		if (target) {
			ui.success(`Checked out ${theme.branch(target.name)}`);
			ui.positionReport({
				stackName: resolvedName,
				index: newIndex,
				total: stack.branches.length,
				branch: target,
				isTop: newIndex === stack.branches.length - 1,
				isBottom: newIndex === 0,
			});
		}
		return 0;
	}
}
