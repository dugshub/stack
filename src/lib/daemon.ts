import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrStatus } from './types.js';

const TOKEN_PATH = join(homedir(), '.claude', 'stacks', 'daemon.token');
const DEFAULT_PORT = 7654;

let cachedToken: string | null | undefined;

export function loadDaemonToken(): string | null {
	if (cachedToken !== undefined) return cachedToken;
	try {
		if (!existsSync(TOKEN_PATH)) {
			cachedToken = null;
			return null;
		}
		cachedToken = readFileSync(TOKEN_PATH, 'utf-8').trim();
		return cachedToken;
	} catch {
		cachedToken = null;
		return null;
	}
}

function getDaemonPort(): number {
	try {
		const configPath = join(homedir(), '.claude', 'stacks', 'server.config.json');
		const text = readFileSync(configPath, 'utf-8');
		const config = JSON.parse(text) as { port?: number };
		return config.port ?? DEFAULT_PORT;
	} catch {
		return DEFAULT_PORT;
	}
}

export async function daemonFetch(path: string, opts?: { method?: string; body?: string; timeout?: number }): Promise<Response | null> {
	const token = loadDaemonToken();
	const port = getDaemonPort();
	try {
		const headers: Record<string, string> = {};
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		if (opts?.body) {
			headers['Content-Type'] = 'application/json';
		}
		const response = await fetch(`http://localhost:${port}${path}`, {
			method: opts?.method ?? 'GET',
			headers,
			body: opts?.body,
			signal: AbortSignal.timeout(opts?.timeout ?? 2000),
		});
		if (!response.ok) return null;
		return response;
	} catch {
		return null;
	}
}

export async function tryDaemonCache(
	owner: string,
	repo: string,
): Promise<Map<number, PrStatus> | null> {
	const response = await daemonFetch(`/api/cache/${owner}/${repo}/prs`);
	if (!response) return null;

	try {
		const data = (await response.json()) as Record<string, PrStatus>;
		const map = new Map<number, PrStatus>();
		for (const [key, value] of Object.entries(data)) {
			map.set(Number(key), value);
		}
		return map.size > 0 ? map : null;
	} catch {
		return null;
	}
}
