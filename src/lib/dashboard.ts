import { tryDaemonCache } from './daemon.js';
import { formatRelativeTime } from './format.js';
import * as gh from './gh.js';
import * as git from './git.js';
import { getHint } from './hints.js';
import { findCommonPrefix } from './stack-report.js';
import { findActiveStack, loadAndRefreshState } from './state.js';
import { theme } from './theme.js';
import type { PrStatus, Stack, StackFile, StackPosition } from './types.js';
import { aggregateStatusEmoji, statusEmoji, statusText } from './ui.js';
import { currentVersion } from './version.js';

/**
 * Show the stacks dashboard. Returns 0 on success, or null if no stacks
 * exist (caller should show help text instead).
 */
export async function showDashboard(): Promise<number | null> {
	// Check if we're in a git repo
	if (!git.tryRun('rev-parse', '--show-toplevel').ok) {
		return null;
	}

	const state = loadAndRefreshState();
	const stackNames = Object.keys(state.stacks);

	if (stackNames.length === 0) {
		return null;
	}

	const position = findActiveStack(state);
	const currentStackName = position?.stackName ?? state.currentStack;

	// Fetch PR statuses for all stacks (daemon cache first, batch fallback)
	const prStatuses = await fetchAllPrStatuses(state);

	const v = currentVersion();
	process.stderr.write(`\n  ${theme.label('st')} ${theme.muted(`v${v}`)}\n`);

	// ── Active stack (expanded) ──────────────────────────────
	if (currentStackName) {
		const stack = state.stacks[currentStackName];
		if (stack) {
			renderActiveStack(currentStackName, stack, position, prStatuses);
		}
	}

	// ── Other stacks (compact) ───────────────────────────────
	const otherStacks = stackNames.filter((n) => n !== currentStackName);
	if (otherStacks.length > 0) {
		process.stderr.write('\n');
		renderCompactStacks(state, otherStacks, prStatuses);
	}

	// ── Quick actions ────────────────────────────────────────
	process.stderr.write('\n');
	renderQuickActions(currentStackName, state);
	process.stderr.write('\n');

	return 0;
}

// ── Active stack rendering ──────────────────────────────────

function renderActiveStack(
	stackName: string,
	stack: Stack,
	position: StackPosition | null,
	prStatuses: Map<number, PrStatus>,
): void {
	const posLabel = position
		? `${theme.muted(`on branch ${position.index + 1}/${position.total}`)}`
		: '';

	process.stderr.write(`\n  ${theme.muted('▸')} ${theme.stack(stackName)}${posLabel ? `  ${posLabel}` : ''}\n`);

	// Trunk header
	process.stderr.write(`    ${theme.muted(`↑ ${stack.trunk}`)}\n`);

	// Show common prefix once if branches share one
	const prefix = findCommonPrefix(stack.branches.map((b) => b.name));

	// Compute column widths
	const numW = String(stack.branches.length).length;
	const shortNames = stack.branches.map((b) =>
		prefix ? b.name.slice(prefix.length) : b.name,
	);
	const nameW = Math.max(4, ...shortNames.map((n) => n.length));
	const prW = Math.max(
		0,
		...stack.branches.map((b) => (b.pr != null ? `#${b.pr}`.length : 5)),
	);

	for (let i = 0; i < stack.branches.length; i++) {
		const branch = stack.branches[i]!;
		const shortName = shortNames[i]!;
		const isCurrent = position ? i === position.index : false;

		const pr = branch.pr != null ? (prStatuses.get(branch.pr) ?? null) : null;
		const emoji = statusEmoji(pr);
		const sText = statusText(pr);

		// PR column
		const prVisible = branch.pr != null ? `#${branch.pr}` : 'No PR';
		const prStr = branch.pr != null
			? theme.pr(prVisible.padEnd(prW))
			: theme.muted(prVisible.padEnd(prW));

		// Branch name
		const namePadded = shortName.padEnd(nameW);
		const nameStr = isCurrent ? theme.branch(namePadded) : namePadded;

		// Position marker
		const marker = isCurrent ? `  ${theme.accent('← you are here')}` : '';

		process.stderr.write(
			`    ${String(i + 1).padEnd(numW)}   ${nameStr}   ${prStr}   ${emoji} ${sText}${marker}\n`,
		);
	}

	// Hint
	const hint = getHint(stack, prStatuses);
	if (hint) {
		process.stderr.write(`\n    ${theme.muted('→')} ${theme.muted(hint)}\n`);
	}
}

// ── Compact stack rendering ─────────────────────────────────

function renderCompactStacks(
	state: StackFile,
	stackNames: string[],
	prStatuses: Map<number, PrStatus>,
): void {
	// Compute column widths for alignment
	const nameW = Math.max(4, ...stackNames.map((n) => n.length));
	const countW = Math.max(
		4,
		...stackNames.map((n) => {
			const s = state.stacks[n];
			const label = s?.branches.length === 1 ? '1 branch' : `${s?.branches.length ?? 0} branches`;
			return label.length;
		}),
	);

	for (const name of stackNames) {
		const stack = state.stacks[name];
		if (!stack) continue;

		const branchWord = stack.branches.length === 1 ? '1 branch' : `${stack.branches.length} branches`;
		const age = formatRelativeTime(stack.updated);

		// Aggregate status across all branches
		const emojis = stack.branches.map((b) => {
			const pr = b.pr != null ? (prStatuses.get(b.pr) ?? null) : null;
			return statusEmoji(pr);
		});
		const aggEmoji = aggregateStatusEmoji(emojis);
		const aggText = statusText(statusFromEmoji(aggEmoji));

		const restackMarker = stack.restackState
			? `  ${theme.warning('(restack in progress)')}`
			: '';

		process.stderr.write(
			`    ${name.padEnd(nameW)}   ${theme.muted(branchWord.padEnd(countW))}   ${aggEmoji} ${aggText}   ${theme.muted(age)}${restackMarker}\n`,
		);
	}
}

// ── Quick actions ───────────────────────────────────────────

function renderQuickActions(
	currentStackName: string | null | undefined,
	state: StackFile,
): void {
	const sep = theme.muted(' · ');

	let actions: string[];

	if (currentStackName) {
		const stack = state.stacks[currentStackName];
		if (stack?.restackState) {
			// Restack in progress
			actions = [
				theme.command('continue'),
				theme.command('abort'),
			];
		} else {
			// Normal on-stack flow
			actions = [
				theme.command('submit'),
				theme.command('sync'),
				theme.command('merge'),
				`${theme.command('up')}/${theme.command('down')}`,
				`${theme.command('create')} ${theme.muted('<name>')}`,
			];
		}
	} else {
		// Not on a stack
		actions = [
			`${theme.command('<name>')} ${theme.muted('to switch')}`,
			`${theme.command('create')} ${theme.muted('<name>')}`,
		];
	}

	const line = actions.join(sep);
	const helpHint = theme.muted('st -h');
	process.stderr.write(`  ${line}${sep}${helpHint}\n`);
}

// ── Helpers ─────────────────────────────────────────────────

async function fetchAllPrStatuses(
	state: StackFile,
): Promise<Map<number, PrStatus>> {
	const allPrNumbers: number[] = [];
	for (const stack of Object.values(state.stacks)) {
		for (const branch of stack.branches) {
			if (branch.pr != null) {
				allPrNumbers.push(branch.pr);
			}
		}
	}

	if (allPrNumbers.length === 0) return new Map();

	const fullName = state.repo || gh.repoFullName();
	const [owner, repoName] = fullName.split('/');
	let prStatuses =
		owner && repoName ? await tryDaemonCache(owner, repoName) : null;
	if (!prStatuses) {
		prStatuses = gh.prViewBatch(allPrNumbers);
	}
	return prStatuses;
}

function statusFromEmoji(
	emoji: string,
): PrStatus | null {
	switch (emoji) {
		case '⬜':
			return null;
		case '✅':
			return { number: 0, title: '', state: 'OPEN', isDraft: false, url: '', reviewDecision: 'APPROVED', checksStatus: null };
		case '❌':
			return { number: 0, title: '', state: 'CLOSED', isDraft: false, url: '', reviewDecision: '', checksStatus: null };
		case '🔨':
			return { number: 0, title: '', state: 'OPEN', isDraft: true, url: '', reviewDecision: '', checksStatus: null };
		case '🔄':
			return { number: 0, title: '', state: 'OPEN', isDraft: false, url: '', reviewDecision: 'CHANGES_REQUESTED', checksStatus: null };
		case '👀':
			return { number: 0, title: '', state: 'OPEN', isDraft: false, url: '', reviewDecision: 'REVIEW_REQUIRED', checksStatus: null };
		default:
			return null;
	}
}
