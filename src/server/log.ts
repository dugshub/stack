import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LogEntry } from './types.js';

const logClients = new Set<WritableStreamDefaultWriter>();
const LOG_FILE = join(homedir(), '.claude', 'stacks', 'daemon.log');
let foreground = false;

export function setForeground(fg: boolean): void {
	foreground = fg;
}

export function log(level: LogEntry['level'], message: string, stack?: string): void {
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		stack,
	};

	// Always write to log file
	try {
		mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
		appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
	} catch {
		// Non-fatal
	}

	// Foreground mode: also write to stdout
	if (foreground) {
		const prefix = { info: ' ', success: '+', error: '!', warn: '?' }[level];
		process.stdout.write(`[${prefix}] ${message}\n`);
	}

	// Push to SSE clients
	const sseData = `data: ${JSON.stringify(entry)}\n\n`;
	for (const writer of logClients) {
		writer.write(new TextEncoder().encode(sseData)).catch(() => {
			logClients.delete(writer);
		});
	}
}

export function addLogClient(writer: WritableStreamDefaultWriter): void {
	logClients.add(writer);
}

export function removeLogClient(writer: WritableStreamDefaultWriter): void {
	logClients.delete(writer);
}
