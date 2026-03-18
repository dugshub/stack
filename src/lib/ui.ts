import Table from 'cli-table3';
import { buildReport } from './stack-report.js';
import { theme } from './theme.js';
import type { CheckResult, PrStatus, Stack, StackPosition, StatusEmoji } from './types.js';

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

export interface GraphNode {
	name: string;
	trunk: string;
	branchCount: number;
	aggregateStatus: StatusEmoji;
	isCurrent: boolean;
	children: GraphNode[];
}

export function statusRank(emoji: StatusEmoji): number {
	switch (emoji) {
		case '\u2B1C': return 0;       // No PR (worst)
		case '\uD83D\uDD28': return 1; // Draft
		case '\u274C': return 2;       // Closed
		case '\uD83D\uDD04': return 2; // Changes Requested
		case '\uD83D\uDC40': return 3; // Review
		case '\u2705': return 4;       // Approved / Merged (best)
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

export function stackGraph(
	roots: Array<{ trunk: string; children: GraphNode[] }>,
	_currentStackName: string | null,
): void {
	for (let r = 0; r < roots.length; r++) {
		const root = roots[r]!;
		if (r > 0) process.stderr.write('\n');
		process.stderr.write(`  ${theme.muted(root.trunk)}\n`);
		renderGraphChildren(root.children, '  ');
	}
}

function renderGraphChildren(nodes: GraphNode[], prefix: string): void {
	const allNodes = flattenNodes(nodes);
	const nameW = Math.max(6, ...allNodes.map((n) => n.name.length));
	const countW = Math.max(1, ...allNodes.map((n) => branchCountLabel(n.branchCount).length));

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		const isLast = i === nodes.length - 1;
		const connector = isLast ? '\u2514\u2500' : '\u251C\u2500';
		const childPrefix = isLast ? '   ' : '\u2502  ';

		const nameStr = node.isCurrent
			? theme.stack(node.name.padEnd(nameW))
			: node.name.padEnd(nameW);
		const countStr = branchCountLabel(node.branchCount).padEnd(countW);
		const emojiStatus = node.aggregateStatus;
		const textStatus = statusText(statusFromEmoji(emojiStatus));
		const marker = node.isCurrent ? `  ${theme.accent('\u2190 you are here')}` : '';

		process.stderr.write(
			`${prefix}${connector} ${nameStr}   ${theme.muted(countStr)}   ${emojiStatus} ${textStatus}${marker}\n`,
		);

		if (node.children.length > 0) {
			renderGraphChildren(node.children, `${prefix}${childPrefix}`);
		}
	}
}

function flattenNodes(nodes: GraphNode[]): GraphNode[] {
	const result: GraphNode[] = [];
	for (const node of nodes) {
		result.push(node);
		if (node.children.length > 0) {
			result.push(...flattenNodes(node.children));
		}
	}
	return result;
}

function branchCountLabel(count: number): string {
	return count === 1 ? '1 branch' : `${count} branches`;
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
