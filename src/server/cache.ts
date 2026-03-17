import type { PrStatus } from '../lib/types.js';
import { ghAsync } from './spawn.js';

interface RepoCacheEntry {
	prs: Map<number, PrStatus>;
	lastRefresh: number;
}

const cache = new Map<string, RepoCacheEntry>();

const STALE_THRESHOLD_MS = 30_000;

export function getCachedPrs(repo: string): Map<number, PrStatus> | null {
	const entry = cache.get(repo);
	if (!entry) return null;
	return entry.prs;
}

export function getCachedPr(repo: string, prNumber: number): PrStatus | null {
	const entry = cache.get(repo);
	if (!entry) return null;
	return entry.prs.get(prNumber) ?? null;
}

export function updateCachedPr(repo: string, prNumber: number, update: Partial<PrStatus>): void {
	let entry = cache.get(repo);
	if (!entry) {
		entry = { prs: new Map(), lastRefresh: 0 };
		cache.set(repo, entry);
	}
	const existing = entry.prs.get(prNumber);
	if (existing) {
		entry.prs.set(prNumber, { ...existing, ...update });
	} else {
		entry.prs.set(prNumber, {
			number: prNumber,
			title: '',
			state: 'OPEN',
			isDraft: false,
			url: '',
			reviewDecision: '',
			checksStatus: null,
			...update,
		});
	}
}

export function isCacheStale(repo: string): boolean {
	const entry = cache.get(repo);
	if (!entry) return true;
	return Date.now() - entry.lastRefresh > STALE_THRESHOLD_MS;
}

export async function refreshCache(repo: string): Promise<void> {
	const [owner, name] = repo.split('/');
	if (!owner || !name) return;

	// Fetch open PRs for the repo via GraphQL
	const query = `query {
    repository(owner: "${owner}", name: "${name}") {
      pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          number title state isDraft url reviewDecision
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        }
      }
    }
  }`;

	const result = await ghAsync('api', 'graphql', '-f', `query=${query}`);
	if (!result.ok) return;

	try {
		const data = JSON.parse(result.stdout) as {
			data: {
				repository: {
					pullRequests: {
						nodes: Array<{
							number: number;
							title: string;
							state: string;
							isDraft: boolean;
							url: string;
							reviewDecision: string | null;
							commits: {
								nodes: Array<{
									commit: {
										statusCheckRollup: { state: string } | null;
									};
								}>;
							};
						}>;
					};
				};
			};
		};

		let entry = cache.get(repo);
		if (!entry) {
			entry = { prs: new Map(), lastRefresh: 0 };
			cache.set(repo, entry);
		}

		for (const pr of data.data.repository.pullRequests.nodes) {
			const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
			entry.prs.set(pr.number, {
				number: pr.number,
				title: pr.title,
				state: pr.state as PrStatus['state'],
				isDraft: pr.isDraft,
				url: pr.url,
				reviewDecision: pr.reviewDecision ?? '',
				checksStatus: (rollup?.state as PrStatus['checksStatus']) ?? null,
			});
		}
		entry.lastRefresh = Date.now();
	} catch {
		// Parse failure — leave cache as-is
	}
}

export function cacheToJson(repo: string): Record<string, PrStatus> {
	const entry = cache.get(repo);
	if (!entry) return {};
	const result: Record<string, PrStatus> = {};
	for (const [num, status] of entry.prs) {
		result[String(num)] = status;
	}
	return result;
}
