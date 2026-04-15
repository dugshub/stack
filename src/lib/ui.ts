import Table from 'cli-table3';
import { buildReport } from './stack-report.js';
import { theme } from './theme.js';
import type { CheckResult, PrStatus, Stack, StackParent, StackPosition, StatusEmoji } from './types.js';

function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function success(msg: string): void {
	process.stderr.write(`${theme.success('\u2713')} ${msg}\n`);
}

export function warn(msg: string): void {
	process.stderr.write(`${theme.warning('\u26A0')} ${msg}\n`);
}

export function error(msg: string): void {
	process.stderr.write(`${theme.error('\u2717')} ${msg}\n`);
}

export function info(msg: string): void {
	process.stderr.write(`${theme.muted(msg)}\n`);
}

export function heading(msg: string): void {
	process.stderr.write(`${theme.label(msg)}\n`);
}

export function statusEmoji(pr: PrStatus | null): StatusEmoji {
	if (!pr) return '\u2B1C';
	if (pr.state === 'MERGED') return '\u2705';
	if (pr.state === 'CLOSED') return '\u274C';
	if (pr.isDraft) return '\uD83D\uDD28';
	if (pr.reviewDecision === 'APPROVED') return '\u2705';
	if (pr.reviewDecision === 'CHANGES_REQUESTED') return '\uD83D\uDD04';
	if (pr.reviewDecision === 'REVIEW_REQUIRED') return '\uD83D\uDC40';
	return '\uD83D\uDC40';
}

export function statusText(pr: PrStatus | null): string {
	if (!pr) return 'No PR';
	if (pr.state === 'MERGED') return 'Merged';
	if (pr.state === 'CLOSED') return 'Closed';
	if (pr.isDraft) return 'Draft';
	if (pr.reviewDecision === 'APPROVED') return 'Approved';
	if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes';
	return 'Review';
}

export function checksEmoji(pr: PrStatus | null): string {
	if (!pr || pr.checksStatus == null) return '';
	if (pr.checksStatus === 'SUCCESS') return '✅';
	if (pr.checksStatus === 'FAILURE' || pr.checksStatus === 'ERROR') return '❌';
	return '🔄'; // PENDING, EXPECTED
}

export function checksText(pr: PrStatus | null): string {
	if (!pr || pr.checksStatus == null) return '';
	if (pr.checksStatus === 'SUCCESS') return 'Pass';
	if (pr.checksStatus === 'FAILURE') return 'Fail';
	if (pr.checksStatus === 'ERROR') return 'Error';
	return 'Running'; // PENDING, EXPECTED
}

export interface BranchRow {
	index: number;
	name: string;
	pr: number | null;
	prStatus: PrStatus | null;
	isCurrent: boolean;
}

export function stackTree(
	stack: Stack,
	position: StackPosition,
	prStatuses: Map<number, PrStatus>,
): void {
	const report = buildReport(stack, position.branch.pr, prStatuses, '');

	const numW = String(report.rows.length).length;
	const branchW = Math.max(6, ...report.rows.map((r) => r.shortName.length));
	const prW = Math.max(2, ...report.rows.map((r) => r.pr != null ? `#${r.pr}`.length : 0));
	const gap = '   ';

	// Trunk header
	let trunkLabel = report.trunk;
	if (report.dependsOn) {
		trunkLabel = `${report.trunk} (\u2192 ${report.dependsOn.stack}${report.dependsOn.pos})`;
	}
	const trunkLine = ` ${theme.muted('\u2191'.padEnd(numW))}${gap}${theme.muted(trunkLabel)}`;
	process.stderr.write(`${trunkLine}\n`);

	// Show common prefix once above column headers
	if (report.prefix) {
		process.stderr.write(`   ${theme.muted(report.prefix)}\n`);
		process.stderr.write('\n');
	}

	// Column headers
	const headerLine = ` ${theme.muted('#'.padEnd(numW))}${gap}${theme.muted('Branch'.padEnd(branchW))}${gap}${theme.muted('PR'.padEnd(prW))}${gap}${theme.muted('Status')}${gap.padEnd(8)}${theme.muted('Checks')}`;
	process.stderr.write(`${headerLine}\n`);

	for (const row of report.rows) {
		const isCurrent = row.index === position.index;

		// PR string: use hyperlink when URL available, pad based on visible text width
		const prVisible = row.pr != null ? `#${row.pr}` : '';
		const pr = row.pr != null ? (prStatuses.get(row.pr) ?? null) : null;
		const prStr = row.pr != null && pr?.url
			? hyperlink(prVisible, pr.url) + ' '.repeat(prW - prVisible.length)
			: prVisible.padEnd(prW);

		const marker = isCurrent ? `${gap}${theme.accent('\u2190 you are here')}` : '';
		const namePadded = row.shortName.padEnd(branchW);
		const nameStr = isCurrent ? theme.branch(namePadded) : namePadded;

		const chksStr = row.checksText ? `${row.checksEmoji} ${row.checksText}` : '';

		const line = ` ${String(row.index + 1).padEnd(numW)}${gap}${nameStr}${gap}${prStr}${gap}${row.status} ${row.statusText.padEnd(10)}${gap}${chksStr}${marker}`;
		process.stderr.write(`${line}\n`);
	}
}

export function branchTable(rows: BranchRow[]): void {
	const table = new Table({
		chars: {
			top: '',
			'top-mid': '',
			'top-left': '',
			'top-right': '',
			bottom: '',
			'bottom-mid': '',
			'bottom-left': '',
			'bottom-right': '',
			left: '',
			'left-mid': '',
			mid: '',
			'mid-mid': '',
			right: '',
			'right-mid': '',
			middle: '  ',
		},
		style: { 'padding-left': 1, 'padding-right': 1 },
	});

	for (const row of rows) {
		const pr = row.prStatus;
		const emoji = statusEmoji(pr);
		const text = statusText(pr);
		const prStr = row.pr != null ? `#${row.pr}` : '';
		const marker = row.isCurrent ? theme.accent('\u2190') : '';
		const name = row.isCurrent ? theme.branch(row.name) : row.name;

		table.push([
			String(row.index + 1),
			name,
			prStr,
			`${emoji} ${text}`,
			marker,
		]);
	}

	process.stderr.write(`${table.toString()}\n`);
}

export function checkResultsTable(results: CheckResult[]): void {
	const numW = String(Math.max(...results.map(r => r.index))).length;
	const branchW = Math.max(6, ...results.map(r => r.branch.length));
	const gap = '  ';

	// Header
	process.stderr.write(` ${theme.muted('#'.padEnd(numW))}${gap}${theme.muted('Branch'.padEnd(branchW))}${gap}${theme.muted('Status'.padEnd(8))}${gap}${theme.muted('Time')}\n`);

	for (const r of results) {
		// Pad plain text FIRST, then apply color (ANSI codes break padEnd)
		const statusPlain = r.ok ? '✓ pass' : '✗ FAIL';
		const statusPadded = statusPlain.padEnd(8);
		const statusStr = r.ok ? theme.success(statusPadded) : theme.error(statusPadded);

		const time = `${(r.durationMs / 1000).toFixed(1)}s`;
		process.stderr.write(` ${String(r.index).padEnd(numW)}${gap}${r.branch.padEnd(branchW)}${gap}${statusStr}${gap}${time}\n`);
	}
}

export function positionReport(pos: StackPosition): void {
	info(
		`Branch ${pos.index + 1} of ${pos.total} in stack ${theme.stack(pos.stackName)}`,
	);
}

// ── Stack Graph ─────────────────────────────────────────

export interface GraphBranchNode {
	name: string;
	shortName: string;
	pr: number | null;
	prStatus: PrStatus | null;
	isCurrent: boolean;
	dependents: GraphStackNode[];
	/** Names of multi-parent stacks that fork into this branch as a secondary parent. */
	joinPointers?: string[];
}

export interface GraphStackNode {
	name: string;
	prefix: string;
	branchCount: number;
	aggregateStatus: StatusEmoji;
	isCurrent: boolean;
	expanded: boolean;
	branches?: GraphBranchNode[];
	children?: GraphStackNode[];
	/** Non-primary parents for multi-parent (join) stacks. */
	joinParents?: StackParent[];
}

export function statusRank(emoji: StatusEmoji): number {
	switch (emoji) {
		case '\u2B1C': return 0;
		case '\uD83D\uDD28': return 1;
		case '\u274C': return 2;
		case '\uD83D\uDD04': return 2;
		case '\uD83D\uDC40': return 3;
		case '\u2705': return 4;
		default: return 0;
	}
}

export function aggregateStatusEmoji(emojis: StatusEmoji[]): StatusEmoji {
	if (emojis.length === 0) return '\u2B1C';
	let worst: StatusEmoji = emojis[0]!;
	let worstRank = statusRank(worst);
	for (let i = 1; i < emojis.length; i++) {
		const e = emojis[i]!;
		const r = statusRank(e);
		if (r < worstRank) {
			worst = e;
			worstRank = r;
		}
	}
	return worst;
}

// ── Graph rendering ─────────────────────────────────────

export const DOT_TRUNK = '\u25C7';    // ◇
export const DOT_STACK = '\u25CF';    // ●
export const DOT_BRANCH = '\u25CB';   // ○
export const DOT_CURRENT = '\u25C9';  // ◉
export const DOT_JOIN = '\u25C6';     // ◆ multi-parent stack node
export const PIPE = '\u2502';         // │
export const FORK_MID = '\u251C';     // ├
export const FORK_END = '\u2570';     // ╰
export const DASH = '\u2500';         // ─
export const DASH_DASHED = '\u254C';  // ╌

export function renderStackGraph(
	roots: Array<{ trunk: string; stacks: GraphStackNode[] }>,
): void {
	process.stderr.write(
		`  ${theme.muted(`${DOT_STACK} stacks  ${DOT_BRANCH} branches  ${DOT_CURRENT} current  ${DOT_TRUNK} trunk`)}\n`,
	);
	process.stderr.write('\n');

	for (let r = 0; r < roots.length; r++) {
		const root = roots[r]!;
		if (r > 0) process.stderr.write('\n');
		process.stderr.write(`  ${theme.muted(`${DOT_TRUNK} ${root.trunk}`)}\n`);
		process.stderr.write(`  ${theme.muted(PIPE)}\n`);
		renderStackNodes(root.stacks, '  ');
	}
}

function renderStackNodes(nodes: GraphStackNode[], prefix: string): void {
	// Compute column widths for alignment across siblings
	const nameW = Math.max(4, ...nodes.map(n => n.name.length));
	const countW = Math.max(4, ...nodes.map(n => {
		const label = n.branchCount === 1 ? '1 branch' : `${n.branchCount} branches`;
		return label.length;
	}));

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		const isLast = i === nodes.length - 1;
		renderOneStack(node, prefix, isLast, nameW, countW);
	}
}

function renderOneStack(node: GraphStackNode, prefix: string, isLast: boolean, nameW?: number, countW?: number): void {
	const connector = isLast ? `${FORK_END}${DASH}` : `${FORK_MID}${DASH}`;
	const continueLine = isLast ? '  ' : `${PIPE} `;

	const isJoin = !!node.joinParents && node.joinParents.length > 0;
	const dot = isJoin ? theme.stack(DOT_JOIN) : theme.stack(DOT_STACK);
	// Pad plain text BEFORE applying theme (ANSI codes break padEnd)
	const namePadded = !node.expanded && nameW ? node.name.padEnd(nameW) : node.name;
	const nameStr = node.isCurrent ? theme.stack(namePadded) : namePadded;
	let suffix = '';
	if (!node.expanded) {
		const countLabel = node.branchCount === 1 ? '1 branch' : `${node.branchCount} branches`;
		const sText = statusText(statusFromEmoji(node.aggregateStatus));
		const countPad = countW ? countLabel.padEnd(countW) : countLabel;
		suffix = `   ${theme.muted(countPad)}   ${node.aggregateStatus} ${sText}`;
	}
	if (isJoin && node.joinParents) {
		const parentLabels = node.joinParents
			.map((p) => `${p.stack}/${p.branch}`)
			.join(', ');
		suffix = `${suffix}   ${theme.muted(`\u21B5 joins ${parentLabels}`)}`;
	}
	const marker = node.isCurrent && !node.expanded
		? `  ${theme.accent('\u2190 you are here')}`
		: '';

	process.stderr.write(
		`${prefix}${theme.muted(connector)}${dot} ${nameStr}${suffix}${marker}\n`,
	);

	const childPrefix = `${prefix}${theme.muted(continueLine)}`;

	if (node.expanded && node.branches) {
		renderExpandedBranches(node.branches, childPrefix);
	} else if (node.children && node.children.length > 0) {
		renderStackNodes(node.children, childPrefix);
	}

	if (!isLast) {
		process.stderr.write(`${prefix}${theme.muted(PIPE)}\n`);
	}
}

function renderExpandedBranches(branches: GraphBranchNode[], prefix: string): void {
	// Compute column widths for alignment
	const nameW = Math.max(4, ...branches.map((b) => (b.shortName || b.name).length));
	const prW = Math.max(0, ...branches.map((b) => b.pr != null ? `#${b.pr}`.length : 0));
	const statusW = Math.max(4, ...branches.map((b) => statusText(b.prStatus).length));

	for (let i = 0; i < branches.length; i++) {
		const branch = branches[i]!;
		const isLast = i === branches.length - 1 && branch.dependents.length === 0;
		const hasMoreAfter = i < branches.length - 1 || branch.dependents.length > 0;
		const connector = !hasMoreAfter && i === branches.length - 1 ? FORK_END : FORK_MID;
		const continueLine = !hasMoreAfter && i === branches.length - 1 ? '  ' : `${PIPE} `;

		const dot = branch.isCurrent ? theme.accent(DOT_CURRENT) : DOT_BRANCH;
		const pr = branch.prStatus;
		const emoji = statusEmoji(pr);
		const text = statusText(pr);
		const textPadded = text.padEnd(statusW);

		const displayName = branch.shortName || branch.name;
		const namePadded = displayName.padEnd(nameW);
		const branchName = branch.isCurrent ? theme.branch(namePadded) : namePadded;

		const prVisible = branch.pr != null ? `#${branch.pr}` : '';
		const prPadded = prVisible.padEnd(prW);
		const prStr = branch.pr != null ? theme.pr(prPadded) : prPadded;

		const marker = branch.isCurrent ? `  ${theme.accent('\u2190 you are here')}` : '';

		process.stderr.write(
			`${prefix}${theme.muted(connector)} ${dot} ${branchName}  ${prStr}  ${emoji} ${textPadded}${marker}\n`,
		);

		// Dashed pointer lines for multi-parent join references
		if (branch.joinPointers && branch.joinPointers.length > 0) {
			const ptrPrefix = `${prefix}${theme.muted(continueLine)}`;
			for (const joinStackName of branch.joinPointers) {
				process.stderr.write(
					`${ptrPrefix}${theme.muted(`${DASH_DASHED}${DASH_DASHED}\u2192 joined into `)}${theme.stack(joinStackName)}\n`,
				);
			}
		}

		if (branch.dependents.length > 0) {
			const depPrefix = `${prefix}${theme.muted(continueLine)}`;
			for (let d = 0; d < branch.dependents.length; d++) {
				const dep = branch.dependents[d]!;
				// Last dependent AND last branch = truly last
				const depIsLast = d === branch.dependents.length - 1 && i === branches.length - 1;
				renderOneStack(dep, depPrefix, depIsLast);
			}
		}
	}
}

function statusFromEmoji(emoji: StatusEmoji): PrStatus | null {
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
