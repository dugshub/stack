import { describe, test, expect } from 'bun:test';
import { isOwnedHook, type GitHubHook } from './webhook-manager.js';

const baseHook = (overrides: Partial<GitHubHook> = {}): GitHubHook => ({
	id: 1,
	config: {
		url: 'https://example.com/webhooks/github',
		content_type: 'json',
	},
	events: ['pull_request', 'push', 'check_suite', 'check_run'],
	...overrides,
});

describe('isOwnedHook', () => {
	test('matches a canonical daemon-owned hook', () => {
		expect(isOwnedHook(baseHook())).toBe(true);
	});

	test('matches regardless of host', () => {
		const hook = baseHook({ config: { url: 'https://other.example.org/webhooks/github', content_type: 'json' } });
		expect(isOwnedHook(hook)).toBe(true);
	});

	test('matches regardless of event order', () => {
		const hook = baseHook({ events: ['check_run', 'check_suite', 'push', 'pull_request'] });
		expect(isOwnedHook(hook)).toBe(true);
	});

	test('rejects when url does not end in /webhooks/github', () => {
		const hook = baseHook({ config: { url: 'https://example.com/some/other/path', content_type: 'json' } });
		expect(isOwnedHook(hook)).toBe(false);
	});

	test('rejects when content_type is form', () => {
		const hook = baseHook({ config: { url: 'https://example.com/webhooks/github', content_type: 'form' } });
		expect(isOwnedHook(hook)).toBe(false);
	});

	test('rejects when events set differs', () => {
		const hook = baseHook({ events: ['pull_request', 'push'] });
		expect(isOwnedHook(hook)).toBe(false);
	});

	test('rejects when events set has extras', () => {
		const hook = baseHook({ events: ['pull_request', 'push', 'check_suite', 'check_run', 'issues'] });
		expect(isOwnedHook(hook)).toBe(false);
	});

	test('rejects when url missing', () => {
		const hook = baseHook({ config: { content_type: 'json' } });
		expect(isOwnedHook(hook)).toBe(false);
	});

	test('rejects when events missing/empty', () => {
		const hook = baseHook({ events: [] });
		expect(isOwnedHook(hook)).toBe(false);
	});
});
