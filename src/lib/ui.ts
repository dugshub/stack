import Table from 'cli-table3';
import { theme } from './theme.js';
import type { PrStatus, Stack, StackPosition, StatusEmoji } from './types.js';

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

	table.push([
		theme.muted('↑'),
		theme.muted(stack.trunk),
		'',
		'',
		'',
		'',
	]);

	table.push([
		theme.muted('#'),
		theme.muted('Branch'),
		theme.muted('PR'),
		theme.muted('Status'),
		theme.muted('Checks'),
		'',
	]);

	for (let i = 0; i < stack.branches.length; i++) {
		const branch = stack.branches[i];
		if (!branch) continue;
		const pr = branch.pr != null ? (prStatuses.get(branch.pr) ?? null) : null;
		const isCurrent = i === position.index;
		const emoji = statusEmoji(pr);
		const text = statusText(pr);
		const prStr = branch.pr != null ? `#${branch.pr}` : '';
		const marker = isCurrent ? theme.accent('\u2190 you are here') : '';
		const nameStr = isCurrent ? theme.branch(branch.name) : branch.name;

		const chk = checksText(pr);
		const chkEmoji = checksEmoji(pr);
		const checksStr = chk ? `${chkEmoji} ${chk}` : '';
		table.push([String(i + 1), nameStr, prStr, `${emoji} ${text}`, checksStr, marker]);
	}

	process.stderr.write(`${table.toString()}\n`);
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

export function positionReport(pos: StackPosition): void {
	info(
		`Branch ${pos.index + 1} of ${pos.total} in stack ${theme.stack(pos.stackName)}`,
	);
}
