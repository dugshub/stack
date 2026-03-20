import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STACKS_DIR = join(homedir(), '.claude', 'stacks');
const PID_FILE = join(STACKS_DIR, 'daemon.pid');
const LOG_FILE = join(STACKS_DIR, 'daemon.log');
const CONFIG_FILE = join(STACKS_DIR, 'server.config.json');
const DEFAULT_PORT = 7654;
const LOG_MAX_BYTES = 1_000_000; // 1MB

export function getDaemonPort(): number {
	try {
		const text = readFileSync(CONFIG_FILE, 'utf-8');
		const config = JSON.parse(text) as { port?: number };
		return config.port ?? DEFAULT_PORT;
	} catch {
		return DEFAULT_PORT;
	}
}

export function isDaemonRunning(): boolean {
	if (!existsSync(PID_FILE)) return false;

	try {
		const pid = Number.parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
		if (Number.isNaN(pid)) {
			cleanupPidFile();
			return false;
		}
		// Check if process is alive (signal 0 = existence check)
		process.kill(pid, 0);
		return true;
	} catch {
		// Process doesn't exist — stale PID file
		cleanupPidFile();
		return false;
	}
}

export async function isDaemonHealthy(): Promise<boolean> {
	const port = getDaemonPort();
	try {
		const response = await fetch(`http://localhost:${port}/health`);
		return response.ok;
	} catch {
		return false;
	}
}

function cleanupPidFile(): void {
	try {
		const { unlinkSync } = require('node:fs') as typeof import('node:fs');
		unlinkSync(PID_FILE);
	} catch { /* ignore */ }
}

function rotateLogIfNeeded(): void {
	try {
		if (!existsSync(LOG_FILE)) return;
		const stat = statSync(LOG_FILE);
		if (stat.size > LOG_MAX_BYTES) {
			const backup = `${LOG_FILE}.1`;
			renameSync(LOG_FILE, backup);
		}
	} catch { /* ignore */ }
}

async function getDaemonPidFromServer(port: number): Promise<number | null> {
	try {
		const { loadDaemonToken } = await import('../lib/daemon-client.js');
		const token = loadDaemonToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const resp = await fetch(`http://localhost:${port}/api/status`, {
			headers,
			signal: AbortSignal.timeout(2000),
		});
		if (!resp.ok) return null;
		const data = (await resp.json()) as { pid?: number };
		return data.pid ?? null;
	} catch {
		return null;
	}
}

export async function startDaemon(): Promise<{ pid: number; port: number }> {
	const port = getDaemonPort();

	// Rotate log file if too large
	rotateLogIfNeeded();

	mkdirSync(STACKS_DIR, { recursive: true });

	const serverPath = join(import.meta.dir, 'index.ts');
	const logFd = openSync(LOG_FILE, 'a');

	// Use Node's child_process with detached:true to properly daemonize
	const proc = spawn('bun', ['run', serverPath], {
		detached: true,
		stdio: ['ignore', logFd, logFd],
	});
	proc.unref();

	const pid = proc.pid!;
	writeFileSync(PID_FILE, String(pid), 'utf-8');

	// Wait up to 5s for health check, then resolve the real PID from the server
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const healthy = await isDaemonHealthy();
		if (healthy) {
			// Get the real PID from the running server (bun run may re-exec)
			const realPid = await getDaemonPidFromServer(port);
			if (realPid && realPid !== pid) {
				writeFileSync(PID_FILE, String(realPid), 'utf-8');
				return { pid: realPid, port };
			}
			return { pid, port };
		}
	}

	// Check if PID is still alive
	try {
		process.kill(pid, 0);
	} catch {
		throw new Error(`Daemon process died immediately. Check ${LOG_FILE} for details.`);
	}

	throw new Error(`Port ${port} in use by another process`);
}

export async function stopDaemon(): Promise<boolean> {
	// Try PID file first
	if (existsSync(PID_FILE)) {
		try {
			const pid = Number.parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
			if (!Number.isNaN(pid)) {
				process.kill(pid, 'SIGTERM');
				cleanupPidFile();
				return true;
			}
		} catch { /* PID file stale, fall through */ }
		cleanupPidFile();
	}

	// Fallback: ask the running server for its real PID
	const realPid = await getDaemonPidFromServer(getDaemonPort());
	if (realPid) {
		try {
			process.kill(realPid, 'SIGTERM');
			return true;
		} catch { /* ignore */ }
	}

	return false;
}

export async function ensureDaemon(): Promise<{ port: number }> {
	const port = getDaemonPort();

	// Check health first — PID file may be stale but daemon could still be running
	if (isDaemonRunning() || await isDaemonHealthy()) {
		return { port };
	}

	// Clean up stale old server.pid if present
	const oldPidFile = join(STACKS_DIR, 'server.pid');
	if (existsSync(oldPidFile)) {
		try {
			const { unlinkSync } = require('node:fs') as typeof import('node:fs');
			unlinkSync(oldPidFile);
		} catch { /* ignore */ }
	}

	const result = await startDaemon();
	process.stderr.write(`daemon started (pid ${result.pid})\n`);
	return { port: result.port };
}

export interface DaemonStatusInfo {
	running: boolean;
	pid: number | null;
	port: number;
	uptime: number | null;
	tunnel: { running: boolean; hostname: string; restarts: number } | null;
	repos: string[];
	activeJobs: number;
}

export async function daemonStatus(): Promise<DaemonStatusInfo> {
	const port = getDaemonPort();
	try {
		const { loadDaemonToken } = await import('../lib/daemon-client.js');
		const token = loadDaemonToken();
		const headers: Record<string, string> = {};
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		const response = await fetch(`http://localhost:${port}/api/status`, {
			headers,
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) {
			return { running: false, pid: null, port, uptime: null, tunnel: null, repos: [], activeJobs: 0 };
		}
		return (await response.json()) as DaemonStatusInfo;
	} catch {
		return { running: false, pid: null, port, uptime: null, tunnel: null, repos: [], activeJobs: 0 };
	}
}
