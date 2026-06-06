import { daemonFetch, loadDaemonToken } from './daemon.js';
import * as gh from './gh.js';
import * as git from './git.js';
import { saveState } from './state.js';
import type { StackFile } from './types.js';
import * as ui from './ui.js';

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

// ── Heal ────────────────────────────────────────────────────────────────────

export type DaemonHealAction =
	| { kind: 'rename'; from: string; to: string }
	| { kind: 'register'; repo: string }
	| { kind: 'none' };

export interface HealPlan {
	/** New slug to write to state.repo, or null if already correct. */
	setStateRepo: string | null;
	/** Suggested origin remote URL (printed by default; rewritten with
	 *  --remote), or null if the origin slug already matches canonical. */
	remoteSetUrl: string | null;
	/** What the daemon should do, or `none` (unreachable, or already correct). */
	daemonAction: DaemonHealAction;
}

export interface PlanHealInput {
	/** Canonical slug from gh.repoFullName() (redirect-following). */
	canonical: string;
	stateSlug: string | null;
	remoteSlug: string | null;
	/** Daemon-watched repos, or null when the daemon is unreachable. */
	watchList: string[] | null;
	/** Current origin remote URL, used to build the suggested set-url command. */
	originUrl?: string | null;
}

/**
 * Pure decision core for `st daemon repo heal`. Given the canonical slug and
 * the three local stores, decide what to repair. No I/O — unit-testable.
 *
 * The daemon action is rename-not-delete: if the OLD slug (state or remote, but
 * not canonical) is in the watch list, move it via rename (the webhook
 * physically lives on the same repo through GitHub's redirect, so the cached
 * hook ID stays valid). Only register when nothing watched maps to this repo.
 */
export function planHeal(input: PlanHealInput): HealPlan {
	const { canonical, stateSlug, remoteSlug, watchList, originUrl } = input;

	const setStateRepo = stateSlug !== canonical ? canonical : null;

	let remoteSetUrl: string | null = null;
	if (remoteSlug !== canonical) {
		// Build the suggested URL by swapping the slug in the current origin URL,
		// preserving host/scheme. Falls back to an https github URL if we have no
		// origin URL to copy the shape from.
		remoteSetUrl =
			(originUrl
				? git.swapSlugInRemoteUrl(originUrl, canonical)
				: null) ?? `https://github.com/${canonical}.git`;
	}

	let daemonAction: DaemonHealAction = { kind: 'none' };
	if (watchList !== null) {
		if (watchList.includes(canonical)) {
			// Already watched under the canonical slug — nothing to do.
			daemonAction = { kind: 'none' };
		} else {
			// Find an old slug (state or remote) that the daemon is still watching.
			const stale = [stateSlug, remoteSlug].find(
				(s): s is string => !!s && s !== canonical && watchList.includes(s),
			);
			if (stale) {
				daemonAction = { kind: 'rename', from: stale, to: canonical };
			} else {
				daemonAction = { kind: 'register', repo: canonical };
			}
		}
	}

	return { setStateRepo, remoteSetUrl, daemonAction };
}

export interface HealResult {
	canonical: string;
	stateUpdated: boolean;
	remoteUpdated: boolean;
	/** True when the user must run the printed set-url command themselves. */
	remoteSuggestionPrinted: boolean;
	daemon: 'rename' | 'register' | 'none' | 'unreachable';
	alreadyHealthy: boolean;
}

/**
 * Imperative shell around planHeal. Fetches the canonical slug (Tier 2,
 * redirect-following — network), reads the daemon watch list (skipped entirely
 * when no daemon token), runs planHeal, and applies the plan: writes
 * state.repo, prints or (with rewriteRemote) rewrites the origin URL, and
 * issues the daemon rename/register call. Never deletes a webhook.
 *
 * Returns null if the canonical slug can't be resolved (no network / no gh).
 */
export async function executeHeal(
	state: StackFile,
	opts: { rewriteRemote: boolean },
): Promise<HealResult | null> {
	let canonical: string;
	try {
		canonical = gh.repoFullName();
	} catch (err) {
		ui.error(`Could not resolve the canonical repo slug (gh): ${err}`);
		return null;
	}

	const stateSlug = state.repo || null;
	const remoteSlug = git.originSlug();
	const currentOriginUrl = git.originUrl();

	// Read the daemon watch list — only when a token exists.
	let watchList: string[] | null = null;
	let daemonReachable = false;
	if (loadDaemonToken() !== null) {
		const response = await daemonFetch('/api/repos', { timeout: 300 });
		if (response) {
			daemonReachable = true;
			try {
				const data = (await response.json()) as {
					repos?: Array<{ repo: string } | string>;
				};
				watchList = (data.repos ?? []).map((r) =>
					typeof r === 'string' ? r : r.repo,
				);
			} catch {
				watchList = [];
			}
		}
	}

	const plan = planHeal({
		canonical,
		stateSlug,
		remoteSlug,
		watchList,
		originUrl: currentOriginUrl,
	});

	const result: HealResult = {
		canonical,
		stateUpdated: false,
		remoteUpdated: false,
		remoteSuggestionPrinted: false,
		daemon: daemonReachable ? 'none' : watchList === null ? 'unreachable' : 'none',
		alreadyHealthy: false,
	};

	// 1. state.repo
	if (plan.setStateRepo !== null) {
		const old = state.repo || '(unset)';
		state.repo = plan.setStateRepo;
		saveState(state);
		result.stateUpdated = true;
		ui.success(`state.repo: ${old} → ${plan.setStateRepo}`);
	}

	// 2. origin URL — print by default, rewrite only with --remote.
	if (plan.remoteSetUrl !== null) {
		if (opts.rewriteRemote) {
			if (git.setOriginUrl(plan.remoteSetUrl)) {
				result.remoteUpdated = true;
				ui.success(`origin remote → ${plan.remoteSetUrl}`);
			} else {
				ui.error('Failed to rewrite the origin remote URL.');
			}
		} else {
			result.remoteSuggestionPrinted = true;
			ui.warn('Origin remote URL still points at the old slug. To fix it:');
			ui.info(`    git remote set-url origin ${plan.remoteSetUrl}`);
			ui.info('  (or re-run `st daemon repo heal --remote` to rewrite it)');
		}
	}

	// 3. daemon
	if (watchList === null) {
		if (loadDaemonToken() !== null) {
			ui.warn(
				'Daemon unreachable — skipped the watch-list repair. Local repairs above are done.',
			);
		}
		result.daemon = loadDaemonToken() !== null ? 'unreachable' : 'none';
	} else if (plan.daemonAction.kind === 'rename') {
		const { from, to } = plan.daemonAction;
		const res = await daemonFetch('/api/repos/rename', {
			method: 'POST',
			body: JSON.stringify({ from, to }),
		});
		if (res) {
			result.daemon = 'rename';
			ui.success(`daemon watch list: ${from} → ${to} (webhook preserved)`);
		} else {
			ui.error('Daemon rename request failed.');
		}
	} else if (plan.daemonAction.kind === 'register') {
		const res = await daemonFetch('/api/repos', {
			method: 'POST',
			body: JSON.stringify({ repo: plan.daemonAction.repo }),
		});
		if (res) {
			result.daemon = 'register';
			ui.success(`daemon now watching ${plan.daemonAction.repo}`);
		} else {
			ui.error('Daemon register request failed.');
		}
	}

	result.alreadyHealthy =
		!result.stateUpdated &&
		!result.remoteUpdated &&
		!result.remoteSuggestionPrinted &&
		(result.daemon === 'none');

	return result;
}
