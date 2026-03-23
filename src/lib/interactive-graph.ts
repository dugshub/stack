import * as readline from 'node:readline';
import { buildGraph } from '../commands/graph.js';
import type { GraphRoot } from '../commands/graph.js';
import * as git from './git.js';
import * as gh from './gh.js';
import { fetchAllPrStatuses } from './pr-status.js';
import { findActiveStack, loadAndRefreshState, saveState } from './state.js';
import { theme } from './theme.js';
import type { GraphBranchNode, GraphStackNode } from './ui.js';
import {
	DOT_TRUNK,
	DOT_STACK,
	DOT_BRANCH,
	DOT_CURRENT,
	PIPE,
	FORK_MID,
	FORK_END,
	DASH,
	statusEmoji,
	statusText,
	positionReport,
	success,
} from './ui.js';

// ── Types ───────────────────────────────────────────────

interface GraphLine {
	/** The full rendered line (with ANSI colors, tree chars, etc.) */
	text: string;
	/** Highlighted version of the line (when cursor is on it) */
	highlightedText: string;
	/** Whether this line is a selectable branch */
	selectable: boolean;
	/** Branch name for checkout (only if selectable) */
	branchName?: string;
	/** Stack name this branch belongs to */
	stackName?: string;
	/** PR number (for opening in browser) */
	pr?: number;
	/** Whether this is the user's current branch */
	isCurrent: boolean;
}

interface GraphAction {
	action: 'checkout' | 'open' | 'quit';
	branchName?: string;
	pr?: number;
}

// ── Flatten graph to lines ──────────────────────────────

function line(text: string, opts?: Partial<GraphLine>): GraphLine {
	return {
		text,
		highlightedText: opts?.highlightedText ?? text,
		selectable: opts?.selectable ?? false,
		branchName: opts?.branchName,
		stackName: opts?.stackName,
		pr: opts?.pr,
		isCurrent: opts?.isCurrent ?? false,
	};
}

export function flattenGraphToLines(
	roots: GraphRoot[],
	currentBranch: string | null,
): GraphLine[] {
	const lines: GraphLine[] = [];

	// Legend
	lines.push(line(
		`  ${theme.muted(`${DOT_STACK} stacks  ${DOT_BRANCH} branches  ${DOT_CURRENT} current  ${DOT_TRUNK} trunk`)}`,
	));
	lines.push(line(''));

	for (let r = 0; r < roots.length; r++) {
		const root = roots[r]!;
		if (r > 0) lines.push(line(''));
		lines.push(line(`  ${theme.muted(`${DOT_TRUNK} ${root.trunk}`)}`));
		lines.push(line(`  ${theme.muted(PIPE)}`));
		flattenStackNodes(lines, root.stacks, '  ', currentBranch);
	}

	// Footer with keybinding hints
	lines.push(line(''));
	lines.push(line(
		`  ${theme.muted('\u2191\u2193/jk navigate \u00b7 enter checkout \u00b7 o open PR \u00b7 q quit')}`,
	));

	return lines;
}

function flattenStackNodes(
	lines: GraphLine[],
	nodes: GraphStackNode[],
	prefix: string,
	currentBranch: string | null,
): void {
	const nameW = Math.max(4, ...nodes.map(n => n.name.length));
	const countW = Math.max(4, ...nodes.map(n => {
		const label = n.branchCount === 1 ? '1 branch' : `${n.branchCount} branches`;
		return label.length;
	}));

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		const isLast = i === nodes.length - 1;
		flattenOneStack(lines, node, prefix, isLast, currentBranch, nameW, countW);
	}
}

function flattenOneStack(
	lines: GraphLine[],
	node: GraphStackNode,
	prefix: string,
	isLast: boolean,
	currentBranch: string | null,
	nameW?: number,
	countW?: number,
): void {
	const connector = isLast ? `${FORK_END}${DASH}` : `${FORK_MID}${DASH}`;
	const continueLine = isLast ? '  ' : `${PIPE} `;

	const dot = theme.stack(DOT_STACK);
	const namePadded = !node.expanded && nameW ? node.name.padEnd(nameW) : node.name;
	const nameStr = node.isCurrent ? theme.stack(namePadded) : namePadded;
	let suffix = '';
	if (!node.expanded) {
		const countLabel = node.branchCount === 1 ? '1 branch' : `${node.branchCount} branches`;
		const sText = statusText(statusFromEmojiStr(node.aggregateStatus));
		const countPad = countW ? countLabel.padEnd(countW) : countLabel;
		suffix = `   ${theme.muted(countPad)}   ${node.aggregateStatus} ${sText}`;
	}
	const marker = node.isCurrent && !node.expanded
		? `  ${theme.accent('\u2190 you are here')}`
		: '';

	lines.push(line(
		`${prefix}${theme.muted(connector)}${dot} ${nameStr}${suffix}${marker}`,
	));

	const childPrefix = `${prefix}${theme.muted(continueLine)}`;

	if (node.expanded && node.branches) {
		flattenExpandedBranches(lines, node.branches, childPrefix, node.name, currentBranch);
	} else if (node.children && node.children.length > 0) {
		flattenStackNodes(lines, node.children, childPrefix, currentBranch);
	}

	if (!isLast) {
		lines.push(line(`${prefix}${theme.muted(PIPE)}`));
	}
}

function flattenExpandedBranches(
	lines: GraphLine[],
	branches: GraphBranchNode[],
	prefix: string,
	stackName: string,
	currentBranch: string | null,
): void {
	const nameW = Math.max(4, ...branches.map((b) => (b.shortName || b.name).length));
	const prW = Math.max(0, ...branches.map((b) => b.pr != null ? `#${b.pr}`.length : 0));
	const statusW = Math.max(4, ...branches.map((b) => statusText(b.prStatus).length));

	for (let i = 0; i < branches.length; i++) {
		const branch = branches[i]!;
		const hasMoreAfter = i < branches.length - 1 || branch.dependents.length > 0;
		const connector = !hasMoreAfter && i === branches.length - 1 ? FORK_END : FORK_MID;
		const continueLine = !hasMoreAfter && i === branches.length - 1 ? '  ' : `${PIPE} `;

		const isCurrent = branch.name === currentBranch;
		const dot = isCurrent ? theme.accent(DOT_CURRENT) : DOT_BRANCH;
		const pr = branch.prStatus;
		const emoji = statusEmoji(pr);
		const text = statusText(pr);
		const textPadded = text.padEnd(statusW);

		const displayName = branch.shortName || branch.name;
		const namePadded = displayName.padEnd(nameW);
		const branchNameStr = isCurrent ? theme.branch(namePadded) : namePadded;

		const prVisible = branch.pr != null ? `#${branch.pr}` : '';
		const prPadded = prVisible.padEnd(prW);
		const prStr = branch.pr != null ? theme.pr(prPadded) : prPadded;

		const marker = isCurrent ? `  ${theme.accent('\u2190 you are here')}` : '';

		const normalText = `${prefix}${theme.muted(connector)} ${dot} ${branchNameStr}  ${prStr}  ${emoji} ${textPadded}${marker}`;

		// Build highlighted version (reverse video)
		const highlightDot = isCurrent ? DOT_CURRENT : DOT_BRANCH;
		const highlightName = displayName.padEnd(nameW);
		const highlightLine = `${prefix}${theme.muted(connector)} ${highlightDot} \x1b[7m ${highlightName}  ${prPadded}  ${emoji} ${textPadded}\x1b[0m`;

		lines.push(line(normalText, {
			highlightedText: highlightLine,
			selectable: true,
			branchName: branch.name,
			stackName,
			pr: branch.pr ?? undefined,
			isCurrent,
		}));

		if (branch.dependents.length > 0) {
			const depPrefix = `${prefix}${theme.muted(continueLine)}`;
			for (let d = 0; d < branch.dependents.length; d++) {
				const dep = branch.dependents[d]!;
				const depIsLast = d === branch.dependents.length - 1 && i === branches.length - 1;
				flattenOneStack(lines, dep, depPrefix, depIsLast, currentBranch);
			}
		}
	}
}

function statusFromEmojiStr(emoji: string): import('./types.js').PrStatus | null {
	switch (emoji) {
		case '\u2B1C': return null;
		case '\u2705': return { number: 0, title: '', state: 'OPEN', isDraft: false, url: '', reviewDecision: 'APPROVED', checksStatus: null };
		case '\u274C': return { number: 0, title: '', state: 'CLOSED', isDraft: false, url: '', reviewDecision: '', checksStatus: null };
		case '\uD83D\uDD28': return { number: 0, title: '', state: 'OPEN', isDraft: true, url: '', reviewDecision: '', checksStatus: null };
		case '\uD83D\uDD04': return { number: 0, title: '', state: 'OPEN', isDraft: false, url: '', reviewDecision: 'CHANGES_REQUESTED', checksStatus: null };
		case '\uD83D\uDC40': return { number: 0, title: '', state: 'OPEN', isDraft: false, url: '', reviewDecision: 'REVIEW_REQUIRED', checksStatus: null };
		default: return null;
	}
}

// ── Interactive select ──────────────────────────────────

function interactiveGraphSelect(
	lines: GraphLine[],
	initialIndex: number,
): Promise<GraphAction> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin });
		readline.emitKeypressEvents(process.stdin, rl);

		if (!process.stdin.setRawMode) {
			rl.close();
			resolve({ action: 'quit' });
			return;
		}

		process.stdin.setRawMode(true);

		const selectableIndices = lines
			.map((l, i) => l.selectable ? i : -1)
			.filter(i => i >= 0);

		let cursorPos = selectableIndices.indexOf(initialIndex);
		if (cursorPos < 0) cursorPos = 0;

		let firstRender = true;

		function render() {
			// Move cursor up to beginning on subsequent renders
			// +1 for the extra newline after all lines
			if (!firstRender) {
				process.stderr.write(`\x1b[${lines.length}A\x1b[J`);
			}
			firstRender = false;

			const selectedIdx = selectableIndices[cursorPos] ?? -1;
			for (const [i, l] of lines.entries()) {
				if (i === selectedIdx) {
					process.stderr.write(`${l.highlightedText}\n`);
				} else {
					process.stderr.write(`${l.text}\n`);
				}
			}
		}

		function cleanup() {
			if (process.stdin.setRawMode) process.stdin.setRawMode(false);
			rl.close();
			process.stdin.pause();
		}

		render();

		process.stdin.on('keypress', (_str: string | undefined, key: readline.Key) => {
			if (!key) return;

			if (key.name === 'up' || key.name === 'k') {
				if (cursorPos > 0) {
					cursorPos--;
					render();
				}
			} else if (key.name === 'down' || key.name === 'j') {
				if (cursorPos < selectableIndices.length - 1) {
					cursorPos++;
					render();
				}
			} else if (key.name === 'return') {
				const idx = selectableIndices[cursorPos];
				const selected = idx != null ? lines[idx] : undefined;
				cleanup();
				if (selected?.branchName) {
					resolve({ action: 'checkout', branchName: selected.branchName });
				} else {
					resolve({ action: 'quit' });
				}
			} else if (key.name === 'o') {
				const idx = selectableIndices[cursorPos];
				const selected = idx != null ? lines[idx] : undefined;
				cleanup();
				if (selected?.pr) {
					resolve({ action: 'open', pr: selected.pr });
				} else {
					resolve({ action: 'quit' });
				}
			} else if (
				key.name === 'q' ||
				key.name === 'escape' ||
				(key.ctrl && key.name === 'c')
			) {
				cleanup();
				resolve({ action: 'quit' });
			}
		});
	});
}

// ── Orchestrator ────────────────────────────────────────

export async function showInteractiveGraph(): Promise<number> {
	const state = loadAndRefreshState();
	const stackNames = Object.keys(state.stacks);

	if (stackNames.length === 0) {
		return 0;
	}

	const position = findActiveStack(state);
	const currentStackName = position?.stackName ?? state.currentStack ?? null;
	const currentBranchName = position?.branch.name ?? null;

	const prStatuses = await fetchAllPrStatuses(state);

	const roots = buildGraph(
		state,
		currentStackName,
		currentBranchName,
		prStatuses,
		true, // expandAll — critical so all stacks have branches populated
	);

	const lines = flattenGraphToLines(roots, currentBranchName);

	// Find initial cursor: the current branch, or first selectable
	let initialIndex = lines.findIndex(l => l.isCurrent && l.selectable);
	if (initialIndex < 0) {
		initialIndex = lines.findIndex(l => l.selectable);
	}
	if (initialIndex < 0) {
		// No selectable lines — just render statically
		for (const l of lines) {
			process.stderr.write(`${l.text}\n`);
		}
		return 0;
	}

	// Guard: if setRawMode is not available, fall back to static render
	if (!process.stdin.setRawMode) {
		for (const l of lines) {
			process.stderr.write(`${l.text}\n`);
		}
		return 0;
	}

	const result = await interactiveGraphSelect(lines, initialIndex);

	if (result.action === 'checkout' && result.branchName) {
		// Auto-stash for checkout (pattern from default.ts)
		const wasDirty = git.isDirty();
		if (wasDirty) git.stashPush({ includeUntracked: true, message: 'stack-auto-stash' });
		git.checkout(result.branchName);
		if (wasDirty) {
			const pop = git.tryRun('stash', 'pop');
			if (!pop.ok) {
				process.stderr.write(`\x1b[33m\u26A0\x1b[0m Auto-stash pop failed \u2014 your changes are in \`git stash\`.\n`);
			}
		}

		// Update state and report
		const newState = loadAndRefreshState();
		const newPosition = findActiveStack(newState);
		if (newPosition) {
			newState.currentStack = newPosition.stackName;
			saveState(newState);
			success(`Switched to ${theme.branch(result.branchName)}`);
			positionReport(newPosition);
		}
		return 0;
	}

	if (result.action === 'open' && result.pr) {
		const fullName = state.repo || gh.repoFullName();
		Bun.spawnSync(['gh', 'pr', 'view', '--web', '-R', fullName, String(result.pr)], {
			stdout: 'inherit',
			stderr: 'inherit',
		});
		return 0;
	}

	// quit
	return 0;
}
