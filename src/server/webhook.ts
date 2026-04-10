import type { WebhookEvent } from './types.js';

export async function verifySignature(
	body: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	if (!signature.startsWith('sha256=')) {
		return false;
	}
	const hex = signature.slice('sha256='.length);
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(body),
	);
	const expected = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return timingSafeEqual(hex, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
	}
	return result === 0;
}

interface PullRequestPayload {
	action: string;
	pull_request: {
		number: number;
		merged: boolean;
	};
	reason?: string;
	repository: {
		full_name: string;
	};
}

interface PushPayload {
	ref: string;
	after: string;
	repository: {
		full_name: string;
	};
}

export function parseWebhook(
	eventType: string,
	payload: unknown,
): WebhookEvent | null {
	if (eventType === 'push') {
		const data = payload as PushPayload;
		if (!data?.ref || !data?.repository?.full_name) return null;
		// Only handle branch pushes (refs/heads/...), not tags
		if (!data.ref.startsWith('refs/heads/')) return null;
		const branch = data.ref.replace('refs/heads/', '');
		return {
			type: 'push',
			repo: data.repository.full_name,
			ref: data.ref,
			branch,
			headSha: data.after,
		};
	}

	if (eventType !== 'pull_request') {
		return null;
	}

	const data = payload as PullRequestPayload;
	if (!data?.pull_request?.number || !data?.repository?.full_name) {
		return null;
	}

	const prNumber = data.pull_request.number;
	const repo = data.repository.full_name;

	if (data.action === 'closed') {
		if (data.pull_request.merged) {
			return { type: 'pr_merged', prNumber, repo };
		}
		return { type: 'pr_closed', prNumber, repo };
	}


	return null;
}
