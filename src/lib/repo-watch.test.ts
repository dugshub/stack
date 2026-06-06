import { describe, expect, test } from 'bun:test';
import { parseSlugFromRemoteUrl } from './git.js';
import { computeDrift } from './repo-watch.js';

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
