import type { DaemonConfig } from './types.js';

let tunnelProc: ReturnType<typeof Bun.spawn> | null = null;
let restartCount = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RESTARTS = 10;

export function startTunnel(config: DaemonConfig): ReturnType<typeof Bun.spawn> | null {
	if (!config.tunnel) {
		console.log('No tunnel config — skipping tunnel start');
		return null;
	}

	const proc = Bun.spawn(
		['cloudflared', 'tunnel', '--config', config.tunnel.configPath, 'run'],
		{
			stdout: 'ignore',
			stderr: 'pipe',
			stdin: 'ignore',
		},
	);

	tunnelProc = proc;

	// Monitor for unexpected exit and auto-restart
	proc.exited.then((exitCode) => {
		console.log(`cloudflared exited with code ${exitCode}`);
		if (tunnelProc === proc) {
			tunnelProc = null;
			if (restartCount < MAX_RESTARTS) {
				restartCount++;
				console.log(`Restarting tunnel (attempt ${restartCount}/${MAX_RESTARTS}) in 5s...`);
				restartTimer = setTimeout(() => {
					startTunnel(config);
				}, 5000);
			} else {
				console.error(`Tunnel exceeded max restarts (${MAX_RESTARTS}). Not retrying.`);
			}
		}
	});

	console.log(`Tunnel started: https://${config.tunnel.hostname}`);
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
		console.log('Tunnel stopped');
	}
}

export function isTunnelRunning(): boolean {
	return tunnelProc !== null;
}

export function getTunnelRestartCount(): number {
	return restartCount;
}
