import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'clipanion';
import {
	daemonStatus,
	getDaemonPort,
	isDaemonRunning,
	startDaemon,
	stopDaemon,
} from '../server/lifecycle.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

const STACKS_DIR = join(homedir(), '.claude', 'stacks');
const LOG_FILE = join(STACKS_DIR, 'daemon.log');
const CONFIG_FILE = join(STACKS_DIR, 'server.config.json');
const DEFAULT_PORT = 7654;

export class DaemonCommand extends Command {
	static override paths = [['daemon']];

	static override usage = Command.Usage({
		description: 'Manage the background daemon',
		examples: [
			['Start the daemon', 'stack daemon start'],
			['Stop the daemon', 'stack daemon stop'],
			['Show daemon status', 'stack daemon status'],
			['View daemon logs', 'stack daemon logs'],
			['Configure daemon', 'stack daemon setup'],
		],
	});

	action = Option.String({ required: false });

	follow = Option.Boolean('-f,--follow', false, {
		description: 'Follow log output (for logs subcommand)',
	});

	async execute(): Promise<number> {
		switch (this.action) {
			case 'start':
				return this.runStart();
			case 'stop':
				return this.runStop();
			case 'status':
				return this.runStatus();
			case 'logs':
				return this.runLogs();
			case 'setup':
				return this.runSetup();
			default:
				return this.runStatus();
		}
	}

	private async runStart(): Promise<number> {
		if (isDaemonRunning()) {
			ui.info('Daemon is already running.');
			return 0;
		}

		try {
			const result = await startDaemon();
			ui.success(`Daemon started (pid ${result.pid}, port ${result.port})`);

			// Show tunnel info if configured
			try {
				const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as { tunnel?: { hostname: string } };
				if (config.tunnel?.hostname) {
					ui.info(`Tunnel: https://${config.tunnel.hostname}`);
				}
			} catch { /* ignore */ }

			return 0;
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}
	}

	private runStop(): number {
		if (stopDaemon()) {
			ui.success('Daemon stopped.');
		} else {
			ui.info('Daemon is not running.');
		}
		return 0;
	}

	private async runStatus(): Promise<number> {
		const info = await daemonStatus();

		if (!info.running) {
			ui.info('Daemon is not running.');
			return 0;
		}

		ui.heading('\n  Daemon Status');
		process.stderr.write(`  ${theme.muted(''.padEnd(34, '\u2500'))}\n`);
		process.stderr.write(`  PID:     ${info.pid}\n`);
		process.stderr.write(`  Port:    ${info.port}\n`);
		if (info.uptime != null) {
			const secs = Math.floor(info.uptime / 1000);
			const mins = Math.floor(secs / 60);
			const hours = Math.floor(mins / 60);
			const uptimeStr = hours > 0
				? `${hours}h ${mins % 60}m`
				: mins > 0
					? `${mins}m ${secs % 60}s`
					: `${secs}s`;
			process.stderr.write(`  Uptime:  ${uptimeStr}\n`);
		}
		if (info.tunnel) {
			const tunnelStatus = info.tunnel.running
				? theme.success('connected')
				: theme.error('disconnected');
			process.stderr.write(`  Tunnel:  ${tunnelStatus} (${info.tunnel.hostname})\n`);
			if (info.tunnel.restarts > 0) {
				process.stderr.write(`  Restarts: ${info.tunnel.restarts}\n`);
			}
		}
		if (info.repos.length > 0) {
			process.stderr.write(`  Repos:   ${info.repos.join(', ')}\n`);
		}
		process.stderr.write(`  Jobs:    ${info.activeJobs}\n`);
		process.stderr.write('\n');
		return 0;
	}

	private runLogs(): number {
		if (!existsSync(LOG_FILE)) {
			ui.info('No daemon logs found.');
			return 0;
		}

		if (this.follow) {
			const proc = Bun.spawnSync(['tail', '-f', LOG_FILE], {
				stdout: 'inherit',
				stderr: 'inherit',
			});
			return proc.exitCode;
		}

		const proc = Bun.spawnSync(['tail', '-50', LOG_FILE], {
			stdout: 'inherit',
			stderr: 'inherit',
		});
		return proc.exitCode;
	}

	private runSetup(): number {
		mkdirSync(STACKS_DIR, { recursive: true });

		// Load or create config
		let config: Record<string, unknown> = {};
		if (existsSync(CONFIG_FILE)) {
			try {
				config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
			} catch { /* fresh config */ }
		}

		// Generate webhook secret if missing
		if (!config.webhookSecret) {
			config.webhookSecret = `whsec_${crypto.randomUUID().replace(/-/g, '')}`;
			ui.success('Generated webhook secret');
		}

		config.port = config.port ?? DEFAULT_PORT;
		config.webhooks = config.webhooks ?? {};
		config.repos = config.repos ?? [];

		// Detect tunnel config
		const tunnelConfigPath = join(homedir(), '.cloudflared', 'config-stack.yml');
		if (existsSync(tunnelConfigPath) && !config.tunnel) {
			config.tunnel = {
				configPath: tunnelConfigPath,
				hostname: 'stack.dugsapps.com',
			};
			config.publicUrl = 'https://stack.dugsapps.com';
			ui.success('Detected Cloudflare tunnel configuration');
		}

		writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

		// Generate daemon token if missing
		const tokenPath = join(STACKS_DIR, 'daemon.token');
		if (!existsSync(tokenPath)) {
			writeFileSync(tokenPath, crypto.randomUUID(), 'utf-8');
			ui.success('Generated daemon auth token');
		}

		ui.success('Daemon configuration saved');
		ui.info(`  Config: ${CONFIG_FILE}`);
		ui.info(`  Port: ${config.port}`);
		if (config.tunnel) {
			const tunnel = config.tunnel as { hostname: string };
			ui.info(`  Tunnel: https://${tunnel.hostname}`);
		}
		process.stderr.write('\n');
		return 0;
	}
}
