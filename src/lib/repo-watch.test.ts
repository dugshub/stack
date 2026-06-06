import { describe, expect, test } from 'bun:test';
import { parseSlugFromRemoteUrl, swapSlugInRemoteUrl } from './git.js';
import { computeDrift, planHeal } from './repo-watch.js';

describe('parseSlugFromRemoteUrl', () => {
	test('ssh scp-style: git@github.com:o/r.git', () => {
		expect(parseSlugFromRemoteUrl('git@github.com:o/r.git')).toBe('o/r');
	});

	test('ssh scp-style without .git: git@github.com:o/r', () => {
		expect(parseSlugFromRemoteUrl('git@github.com:o/r')).toBe('o/r');
	});

	test('https with .git: https://github.com/o/r.git', () => {
		expect(parseSlugFromRemoteUrl('https://github.com/o/r.git')).toBe('o/r');
	});

	test('https without .git: https://github.com/o/r', () => {
		expect(parseSlugFromRemoteUrl('https://github.com/o/r')).toBe('o/r');
	});

	test('ssh:// scheme: ssh://git@github.com/o/r.git', () => {
		expect(parseSlugFromRemoteUrl('ssh://git@github.com/o/r.git')).toBe('o/r');
	});

	test('strips a trailing slash', () => {
		expect(parseSlugFromRemoteUrl('https://github.com/o/r/')).toBe('o/r');
	});

	test('trims surrounding whitespace/newline', () => {
		expect(parseSlugFromRemoteUrl('  git@github.com:o/r.git\n')).toBe('o/r');
	});

	test('enterprise host (non-github)', () => {
		expect(parseSlugFromRemoteUrl('git@ghe.corp.io:team/proj.git')).toBe(
			'team/proj',
		);
	});

	test('garbage with no owner/repo returns null', () => {
		expect(parseSlugFromRemoteUrl('not-a-url')).toBeNull();
	});

	test('empty string returns null', () => {
		expect(parseSlugFromRemoteUrl('')).toBeNull();
	});

	test('only a host, no path returns null', () => {
		expect(parseSlugFromRemoteUrl('https://github.com/')).toBeNull();
	});
});

describe('computeDrift', () => {
	test('both present and different -> drifted', () => {
		expect(computeDrift('old/repo', 'new/repo')).toBe(true);
	});

	test('both present and equal -> not drifted', () => {
		expect(computeDrift('o/r', 'o/r')).toBe(false);
	});

	test('state slug missing -> not drifted', () => {
		expect(computeDrift(null, 'o/r')).toBe(false);
	});

	test('remote slug missing -> not drifted', () => {
		expect(computeDrift('o/r', null)).toBe(false);
	});

	test('both missing -> not drifted', () => {
		expect(computeDrift(null, null)).toBe(false);
	});

	test('empty-string state slug -> not drifted', () => {
		expect(computeDrift('', 'o/r')).toBe(false);
	});
});

describe('swapSlugInRemoteUrl', () => {
	test('ssh scp-style with .git', () => {
		expect(swapSlugInRemoteUrl('git@github.com:old/repo.git', 'new/repo')).toBe(
			'git@github.com:new/repo.git',
		);
	});

	test('https with .git', () => {
		expect(
			swapSlugInRemoteUrl('https://github.com/old/repo.git', 'new/name'),
		).toBe('https://github.com/new/name.git');
	});

	test('https without .git', () => {
		expect(swapSlugInRemoteUrl('https://github.com/old/repo', 'new/name')).toBe(
			'https://github.com/new/name',
		);
	});

	test('unparseable URL returns null', () => {
		expect(swapSlugInRemoteUrl('garbage', 'new/name')).toBeNull();
	});
});

describe('planHeal', () => {
	const base = {
		canonical: 'new/repo',
		stateSlug: 'new/repo',
		remoteSlug: 'new/repo',
		watchList: ['new/repo'] as string[] | null,
		originUrl: 'git@github.com:new/repo.git',
	};

	test('already healthy -> all none', () => {
		const plan = planHeal(base);
		expect(plan.setStateRepo).toBeNull();
		expect(plan.remoteSetUrl).toBeNull();
		expect(plan.daemonAction).toEqual({ kind: 'none' });
	});

	test('state stale only', () => {
		const plan = planHeal({ ...base, stateSlug: 'old/repo' });
		expect(plan.setStateRepo).toBe('new/repo');
		expect(plan.remoteSetUrl).toBeNull();
		expect(plan.daemonAction).toEqual({ kind: 'none' });
	});

	test('remote stale only -> suggests set-url, preserves URL shape', () => {
		const plan = planHeal({
			...base,
			remoteSlug: 'old/repo',
			originUrl: 'git@github.com:old/repo.git',
		});
		expect(plan.setStateRepo).toBeNull();
		expect(plan.remoteSetUrl).toBe('git@github.com:new/repo.git');
	});

	test('remote stale with no origin URL -> https fallback', () => {
		const plan = planHeal({
			...base,
			remoteSlug: 'old/repo',
			originUrl: null,
		});
		expect(plan.remoteSetUrl).toBe('https://github.com/new/repo.git');
	});

	test('both stale', () => {
		const plan = planHeal({
			...base,
			stateSlug: 'old/repo',
			remoteSlug: 'old/repo',
			originUrl: 'git@github.com:old/repo.git',
			watchList: ['old/repo'],
		});
		expect(plan.setStateRepo).toBe('new/repo');
		expect(plan.remoteSetUrl).toBe('git@github.com:new/repo.git');
		expect(plan.daemonAction).toEqual({
			kind: 'rename',
			from: 'old/repo',
			to: 'new/repo',
		});
	});

	test('old slug in watch list (via remote) -> rename', () => {
		const plan = planHeal({
			...base,
			stateSlug: 'new/repo',
			remoteSlug: 'old/repo',
			originUrl: 'git@github.com:old/repo.git',
			watchList: ['old/repo'],
		});
		expect(plan.daemonAction).toEqual({
			kind: 'rename',
			from: 'old/repo',
			to: 'new/repo',
		});
	});

	test('neither slug watched -> register canonical', () => {
		const plan = planHeal({
			...base,
			watchList: ['unrelated/repo'],
		});
		expect(plan.daemonAction).toEqual({ kind: 'register', repo: 'new/repo' });
	});

	test('canonical already watched -> daemon none', () => {
		const plan = planHeal({
			...base,
			stateSlug: 'old/repo',
			watchList: ['new/repo'],
		});
		expect(plan.daemonAction).toEqual({ kind: 'none' });
	});

	test('daemon unreachable -> none, local repairs still planned', () => {
		const plan = planHeal({
			...base,
			stateSlug: 'old/repo',
			remoteSlug: 'old/repo',
			originUrl: 'git@github.com:old/repo.git',
			watchList: null,
		});
		expect(plan.setStateRepo).toBe('new/repo');
		expect(plan.remoteSetUrl).toBe('git@github.com:new/repo.git');
		expect(plan.daemonAction).toEqual({ kind: 'none' });
	});
});
