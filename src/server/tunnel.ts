import { log } from './log.js';
import type { DaemonConfig } from './types.js';

export type TunnelStartedCallback = (publicUrl: string) => void;

let tunnelProc: ReturnType<typeof Bun.spawn> | null = null;
let restartCount = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RESTARTS = 10;
const QUICK_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function startTunnel(
	config: DaemonConfig,
	onUrlReady?: TunnelStartedCallback,
): ReturnType<typeof Bun.spawn> | null {
	if (!config.tunnel) {
		log('info', 'No tunnel config — skipping tunnel start');
		return null;
	}

	const t = config.tunnel;
	const args =
		t.mode === 'named'
			? ['cloudflared', 'tunnel', '--config', t.configPath, 'run']
			: ['cloudflared', 'tunnel', '--url', `http://localhost:${config.port}`, '--no-autoupdate'];

	const proc = Bun.spawn(args, {
		stdout: 'ignore',
		stderr: 'pipe',
		stdin: 'ignore',
	});

	tunnelProc = proc;

	if (t.mode === 'named') {
		log('success', `Tunnel started: https://${t.hostname}`);
		if (onUrlReady) onUrlReady(`https://${t.hostname}`);
	} else {
		// Read stderr line by line, look for the trycloudflare URL banner.
		let urlReported = false;
		(async () => {
			const stderr = proc.stderr;
			if (!stderr || typeof stderr === 'number') return;
			const reader = (stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';
					for (const line of lines) {
						if (urlReported) continue;
						const match = line.match(QUICK_URL_REGEX);
						if (match) {
							urlReported = true;
							const url = match[0];
							log('success', `Tunnel started: ${url}`);
							if (onUrlReady) onUrlReady(url);
						}
					}
				}
			} catch {
				/* stream closed */
			}
		})();
	}

	// Monitor for unexpected exit and auto-restart
	proc.exited.then((exitCode) => {
		log('warn', `cloudflared exited with code ${exitCode}`);
		if (tunnelProc === proc) {
			tunnelProc = null;
			if (restartCount < MAX_RESTARTS) {
				restartCount++;
				log('info', `Restarting tunnel (attempt ${restartCount}/${MAX_RESTARTS}) in 5s...`);
				restartTimer = setTimeout(() => {
					startTunnel(config, onUrlReady);
				}, 5000);
			} else {
				log('error', `Tunnel exceeded max restarts (${MAX_RESTARTS}). Not retrying.`);
			}
		}
	});

	return proc;
}

export function stopTunnel(): void {
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	if (tunnelProc) {
		const proc = tunnelProc;
		tunnelProc = null; // Prevent auto-restart
		proc.kill('SIGTERM');
		log('info', 'Tunnel stopped');
	}
}

export function isTunnelRunning(): boolean {
	return tunnelProc !== null;
}

export function getTunnelRestartCount(): number {
	return restartCount;
}
