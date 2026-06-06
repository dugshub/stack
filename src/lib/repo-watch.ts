import { daemonFetch, loadDaemonToken } from './daemon.js';
import * as git from './git.js';
import type { StackFile } from './types.js';

export interface RepoWatchStatus {
	/** state.repo, or null if unset. */
	stateSlug: string | null;
	/** git.originSlug() — Tier 1, parsed from the origin remote URL. */
	remoteSlug: string | null;
	/** Both present and different — the state file holds a stale slug. */
	drifted: boolean;
	/** Whether the canonical slug is in the daemon watch list.
	 *  null = daemon absent (no token) or unreachable — unknown. */
	watched: boolean | null;
}

/**
 * Pure drift check: drifted iff both slugs are present and differ. A missing
 * remote or state slug yields false (no evidence of drift). Unit-testable.
 */
export function computeDrift(
	stateSlug: string | null,
	remoteSlug: string | null,
): boolean {
	if (!stateSlug || !remoteSlug) return false;
	return stateSlug !== remoteSlug;
}

/**
 * Tier-1 drift detection + an on-demand daemon watch probe.
 *
 * Tier 1 (free): parse `owner/repo` from the origin remote URL and compare to
 * `state.repo`. No network.
 *
 * Watch probe: only runs when `loadDaemonToken()` is non-null (a daemon user) —
 * non-daemon users pay zero cost and `watched` stays null. When the token
 * exists but the daemon is unreachable, `watched` also stays null (we can't
 * know; don't nag people who stopped the daemon). The probe uses a short
 * 300ms timeout so a stopped daemon adds at most ~300ms.
 */
export async function repoWatchStatus(state: StackFile): Promise<RepoWatchStatus> {
	const stateSlug = state.repo || null;
	const remoteSlug = git.originSlug();
	const drifted = computeDrift(stateSlug, remoteSlug);

	let watched: boolean | null = null;
	// Skip the probe entirely when no daemon token exists.
	if (loadDaemonToken() !== null) {
		// The slug the daemon would key on: the canonical local slug. Prefer the
		// remote (Tier-1 authoritative) and fall back to state.
		const slug = remoteSlug ?? stateSlug;
		if (slug) {
			const response = await daemonFetch('/api/repos', { timeout: 300 });
			if (response) {
				try {
					const data = (await response.json()) as {
						repos?: Array<{ repo: string } | string>;
					};
					const list = (data.repos ?? []).map((r) =>
						typeof r === 'string' ? r : r.repo,
					);
					watched = list.includes(slug);
				} catch {
					watched = null;
				}
			}
		}
	}

	return { stateSlug, remoteSlug, drifted, watched };
}
