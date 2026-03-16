import { formatRelativeTime } from './format.js';
import * as git from './git.js';
import { findActiveStack, loadAndRefreshState } from './state.js';
import { theme } from './theme.js';
import { currentVersion } from './version.js';

/**
 * Show the stacks dashboard. Returns 0 on success, or null if no stacks
 * exist (caller should show help text instead).
 */
export function showDashboard(): number | null {
	// Check if we're in a git repo
	if (!git.tryRun('rev-parse', '--show-toplevel').ok) {
		return null;
	}

	const state = loadAndRefreshState();
	const stackNames = Object.keys(state.stacks);

	if (stackNames.length === 0) {
		return null;
	}

	// Determine current stack for the indicator
	const position = findActiveStack(state);
	const currentStackName = position?.stackName ?? state.currentStack;

	const v = currentVersion();
	process.stderr.write(`\n  ${theme.label('stack')} ${theme.muted(`v${v}`)}\n`);
	process.stderr.write(`  ${theme.muted('Stacked PRs for GitHub')}\n\n`);

	for (const name of stackNames) {
		const stack = state.stacks[name];
		if (!stack) continue;
		const age = formatRelativeTime(stack.updated);
		const branchWord = stack.branches.length === 1 ? 'branch' : 'branches';
		const marker = name === currentStackName ? '\u25B8 ' : '  ';
		const nameStr = name === currentStackName ? theme.stack(name) : name;
		const restackMarker = stack.restackState ? `  ${theme.warning('(restack in progress)')}` : '';
		process.stderr.write(
			`${marker}${nameStr}   ${stack.branches.length} ${branchWord}   updated ${age}${restackMarker}\n`,
		);
	}

	process.stderr.write(`\n  ${theme.muted('stack <name> to switch   stack create <name> to start')}\n\n`);
	return 0;
}
