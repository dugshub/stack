import * as p from '@clack/prompts';
import { formatRelativeTime } from './format.js';
import { findActiveStack, saveState } from './state.js';
import type { Stack, StackFile, StackPosition } from './types.js';

export interface ResolveOptions {
	state: StackFile;
	explicitName?: string;
	interactive?: boolean;
}

export interface ResolvedStack {
	stackName: string;
	stack: Stack;
	position: StackPosition | null;
}

export async function resolveStack(opts: ResolveOptions): Promise<ResolvedStack> {
	const { state, explicitName } = opts;
	const interactive = opts.interactive ?? process.stderr.isTTY;

	// 1. Explicit name (do NOT update currentStack)
	if (explicitName) {
		const stack = state.stacks[explicitName];
		if (!stack) {
			throw new Error(`Stack "${explicitName}" not found.`);
		}
		// Check if we happen to be on a branch in this stack
		const position = findActiveStack(state);
		const matchesStack = position && position.stackName === explicitName;
		return {
			stackName: explicitName,
			stack,
			position: matchesStack ? position : null,
		};
	}

	// 2. Current branch — auto-update currentStack
	const position = findActiveStack(state);
	if (position) {
		const stack = state.stacks[position.stackName];
		if (stack) {
			state.currentStack = position.stackName;
			saveState(state);
			return { stackName: position.stackName, stack, position };
		}
	}

	// 3. Persisted currentStack (staleness-guarded)
	if (state.currentStack) {
		const stack = state.stacks[state.currentStack];
		if (stack) {
			return { stackName: state.currentStack, stack, position: null };
		}
		// Stale — clear and fall through
		state.currentStack = null;
		saveState(state);
	}

	// 4. Single-stack fallback
	const names = Object.keys(state.stacks);
	if (names.length === 1) {
		const stackName = names[0]!;
		const stack = state.stacks[stackName]!;
		return { stackName, stack, position: null };
	}

	// 5. Interactive picker — set currentStack
	if (interactive && names.length > 0) {
		const options = Object.entries(state.stacks).map(([name, stack]) => ({
			value: name,
			label: name,
			hint: `${stack.branches.length} branches, updated ${formatRelativeTime(stack.updated)}`,
		}));

		const selected = await p.select({
			message: 'Which stack?',
			options,
		});

		if (p.isCancel(selected)) {
			throw new Error('Cancelled.');
		}

		const stackName = selected as string;
		const stack = state.stacks[stackName]!;
		state.currentStack = stackName;
		saveState(state);
		return { stackName, stack, position: null };
	}

	// 6. Error
	throw new Error('No stack selected. Run `stack <name>` to select one.');
}
