import type { PrStatus, Stack } from './types.js';
import { theme } from './theme.js';

/**
 * Analyze stack state and return the single most relevant hint, or null.
 * Scenarios checked in priority order (first match wins).
 */
export function getHint(
	stack: Stack,
	prStatuses: Map<number, PrStatus>,
): string | null {
	// 1. Restack in progress — already shown as a warning, don't duplicate
	if (stack.restackState) return null;

	const branches = stack.branches;
	const prs = branches.map((b) =>
		b.pr != null ? (prStatuses.get(b.pr) ?? null) : null,
	);

	// 2. Any PR merged → sync
	const hasMerged = prs.some((pr) => pr?.state === 'MERGED');
	if (hasMerged) {
		return `A PR was merged — run ${theme.command('stack sync')} to clean up`;
	}

	// 3. No PRs at all → submit
	const hasAnyPr = branches.some((b) => b.pr != null);
	if (!hasAnyPr) {
		return `No PRs yet — run ${theme.command('stack submit')} to create them`;
	}

	// 4. Some branches missing PRs → submit
	const missingPrs = branches.filter((b) => b.pr == null);
	if (missingPrs.length > 0) {
		return `${missingPrs.length} branch${missingPrs.length > 1 ? 'es' : ''} without PRs — run ${theme.command('stack submit')}`;
	}

	// 5. Checks failing
	const failing = prs.filter(
		(pr): pr is PrStatus =>
			pr != null &&
			(pr.checksStatus === 'FAILURE' || pr.checksStatus === 'ERROR'),
	);
	if (failing.length > 0) {
		const nums = failing.map((pr) => `#${pr.number}`).join(', ');
		return `Checks failing on ${nums} — push fixes or run ${theme.command('stack absorb')}`;
	}

	// 6. Changes requested
	const changesReq = prs.filter(
		(pr): pr is PrStatus =>
			pr != null && pr.reviewDecision === 'CHANGES_REQUESTED',
	);
	if (changesReq.length > 0) {
		const nums = changesReq.map((pr) => `#${pr.number}`).join(', ');
		return `Changes requested on ${nums}`;
	}

	// 7. All approved + checks pass → merge
	const openPrs = prs.filter(
		(pr): pr is PrStatus => pr != null && pr.state === 'OPEN',
	);
	const allApproved =
		openPrs.length > 0 &&
		openPrs.every((pr) => pr.reviewDecision === 'APPROVED');
	const hasChecks = openPrs.some((pr) => pr.checksStatus != null);
	const allChecksPass = openPrs.every(
		(pr) => pr.checksStatus === 'SUCCESS' || pr.checksStatus == null,
	);
	if (allApproved && hasChecks && allChecksPass) {
		return `All PRs approved — run ${theme.command('stack merge --all')} to land the stack`;
	}
	if (allApproved && hasChecks) {
		return `All PRs approved — waiting for checks to pass`;
	}
	if (allApproved) {
		return `All PRs approved — run ${theme.command('stack merge --all')} to land the stack`;
	}

	// 8. All drafts → suggest marking ready
	const allDrafts =
		openPrs.length > 0 && openPrs.every((pr) => pr.isDraft);
	if (allDrafts) {
		return `All PRs are drafts — mark ready for review when done`;
	}

	// 9. Everything in review → waiting
	const inReview = openPrs.filter(
		(pr) => pr.reviewDecision === 'REVIEW_REQUIRED',
	);
	if (inReview.length === openPrs.length && openPrs.length > 0) {
		return `Waiting on reviewers`;
	}

	return null;
}
