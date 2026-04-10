import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { theme } from '../lib/theme.js';
import type { LogEntry } from './types.js';

const logClients = new Set<WritableStreamDefaultWriter>();
const LOG_FILE = join(homedir(), '.claude', 'stacks', 'daemon.log');
let foreground = false;

export function setForeground(fg: boolean): void {
	foreground = fg;
}

export function log(level: LogEntry['level'], message: string, stack?: string, category?: LogEntry['category'], indent?: boolean): void {
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		stack,
		...(category && { category }),
		...(indent && { indent }),
	};

	// Always write to log file
	try {
		mkdirSync(join(homedir(), '.claude', 'stacks'), { recursive: true });
		appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
	} catch {
		// Non-fatal
	}

	// Foreground mode: also write to stdout with color
	if (foreground) {
		const time = theme.muted(entry.timestamp.slice(11, 19));
		const stackTag = stack ? theme.stack(` ${stack}`) : '';
		const bar = indent ? theme.muted('│ ') : '';

		if (category) {
			const { pfx, color } = {
				webhook: { pfx: '←', color: theme.accent },
				git: { pfx: '$', color: theme.warning },
				api: { pfx: '→', color: theme.pr },
			}[category] ?? { pfx: ' ', color: theme.muted };
			const msg = level === 'error' ? theme.error(message) : color(message);
			process.stdout.write(`${time} ${bar}${color(pfx)}${stackTag} ${msg}\n`);
		} else {
			const { pfx, color } = {
				success: { pfx: '+', color: theme.success },
				error: { pfx: '!', color: theme.error },
				warn: { pfx: '?', color: theme.warning },
				info: { pfx: ' ', color: (s: string) => s },
			}[level] ?? { pfx: ' ', color: (s: string) => s };
			process.stdout.write(`${time} ${bar}${color(pfx)}${stackTag} ${color(message)}\n`);
		}
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
