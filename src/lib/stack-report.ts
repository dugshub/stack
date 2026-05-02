import { parseBranchName } from './branch.js';
import type { PrStatus, Stack } from './types.js';
import { checksEmoji, checksText, statusEmoji, statusText } from './ui.js';

export interface StackRow {
	index: number;
	shortName: string;
	fullName: string;
	pr: number | null;
	prUrl: string | null;
	title: string;
	status: string;
	statusText: string;
	checksStatus: string | null;
	checksEmoji: string;
	checksText: string;
	isCurrent: boolean;
}

export interface StackReport {
	prefix: string;
	trunk: string;
	/** First parent, kept for backwards compatibility with existing renderers. */
	dependsOn?: { stack: string; pos: string };
	/** All parents (primary + secondaries) for diamond stacks. */
	dependsOnAll?: Array<{ stack: string; pos: string }>;
	rows: StackRow[];
}

export function buildReport(
	stack: Stack,
	currentPrNumber: number | null,
	prStatuses: Map<number, PrStatus>,
	repoUrl: string,
): StackReport {
	const prefix = findCommonPrefix(stack.branches.map((b) => b.name));

	const rows: StackRow[] = stack.branches.map((branch, i) => {
		const pr =
			branch.pr != null ? (prStatuses.get(branch.pr) ?? null) : null;
		const isCurrent = branch.pr != null && branch.pr === currentPrNumber;
		const shortName = prefix ? branch.name.slice(prefix.length) : branch.name;

		return {
			index: i,
			shortName,
			fullName: branch.name,
			pr: branch.pr,
			prUrl:
				branch.pr != null ? `${repoUrl}/pull/${branch.pr}` : null,
			title: pr?.title ?? '',
			status: statusEmoji(pr),
			statusText: statusText(pr),
			checksStatus: pr?.checksStatus ?? null,
			checksEmoji: checksEmoji(pr),
			checksText: checksText(pr),
			isCurrent,
		};
	});

	let dependsOn: StackReport['dependsOn'];
	let dependsOnAll: StackReport['dependsOnAll'];
	const parents = stack.dependsOn ?? [];
	if (parents.length > 0) {
		dependsOnAll = parents.map((p) => {
			const parsed = parseBranchName(p.branch);
			return { stack: p.stack, pos: parsed ? `#${parsed.index}` : '' };
		});
		dependsOn = dependsOnAll[0];
	}

	return { prefix, trunk: stack.trunk, dependsOn, dependsOnAll, rows };
}

export function findCommonPrefix(names: string[]): string {
	if (names.length === 0) return '';
	if (names.length === 1) {
		const lastSlash = names[0]!.lastIndexOf('/');
		return lastSlash >= 0 ? names[0]!.slice(0, lastSlash + 1) : '';
	}

	const first = names[0]!;
	let prefixLen = 0;
	for (let i = 0; i < first.length; i++) {
		if (names.every((n) => n[i] === first[i])) {
			prefixLen = i + 1;
		} else {
			break;
		}
	}

	const raw = first.slice(0, prefixLen);
	const lastSlash = raw.lastIndexOf('/');
	return lastSlash >= 0 ? raw.slice(0, lastSlash + 1) : '';
}
