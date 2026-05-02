import { Command, Option } from 'clipanion';
import { daemonFetch } from '../lib/daemon.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

type ListResponse = {
	repos: Array<{ repo: string; hookId: number | null }>;
};

type DoctorResponse = {
	orphans: Array<{ repo: string; hookId: number; url: string }>;
	deleted: number;
};

/**
 * `st daemon repo {add|remove|list|doctor}`
 *
 * Manage which repos the daemon watches and reconcile orphan webhooks on
 * GitHub. `doctor` lists hooks the daemon recognizes as its own but isn't
 * tracking; `doctor --clean` deletes them. See webhook-manager's
 * `isOwnedHook` for the ownership heuristic.
 */
export class DaemonRepoCommand extends Command {
	static override paths = [['daemon', 'repo']];

	static override usage = Command.Usage({
		description: 'Manage daemon-watched repos and orphan webhooks',
		examples: [
			['List repos the daemon is watching', 'st daemon repo list'],
			['Register a repo with the daemon', 'st daemon repo add owner/name'],
			['Unregister a repo', 'st daemon repo remove owner/name'],
			['Show orphan webhooks on GitHub', 'st daemon repo doctor'],
			['Delete orphan webhooks', 'st daemon repo doctor --clean'],
		],
	});

	action = Option.String({ required: false });
	target = Option.String({ required: false });
	clean = Option.Boolean('--clean', false, {
		description: 'Delete orphan webhooks (with `doctor`)',
	});

	async execute(): Promise<number> {
		switch (this.action) {
			case 'add':
				return this.runAdd();
			case 'remove':
			case 'rm':
				return this.runRemove();
			case 'list':
			case 'ls':
				return this.runList();
			case 'doctor':
				return this.runDoctor();
			case undefined:
				return this.runList();
			default:
				ui.error(`Unknown action: ${this.action}`);
				ui.info('Try: add | remove | list | doctor');
				return 1;
		}
	}

	private async runAdd(): Promise<number> {
		if (!this.target) {
			ui.error('Usage: st daemon repo add <owner/repo>');
			return 1;
		}
		const res = await daemonFetch('/api/repos', {
			method: 'POST',
			body: JSON.stringify({ repo: this.target }),
		});
		if (!res) {
			ui.error('Daemon not reachable. Is it running? (`st daemon start`)');
			return 1;
		}
		ui.success(`Registered ${this.target}`);
		return 0;
	}

	private async runRemove(): Promise<number> {
		if (!this.target) {
			ui.error('Usage: st daemon repo remove <owner/repo>');
			return 1;
		}
		const res = await daemonFetch(`/api/repos/${encodeURIComponent(this.target)}`, {
			method: 'DELETE',
		});
		if (!res) {
			ui.error('Daemon not reachable.');
			return 1;
		}
		ui.success(`Unregistered ${this.target}`);
		return 0;
	}

	private async runList(): Promise<number> {
		const res = await daemonFetch('/api/repos');
		if (!res) {
			ui.error('Daemon not reachable.');
			return 1;
		}
		const data = (await res.json()) as ListResponse;
		if (data.repos.length === 0) {
			ui.info('No repos registered. Add one with `st daemon repo add <owner/repo>`.');
			return 0;
		}
		for (const r of data.repos) {
			const id = r.hookId ?? theme.muted('(no hook)');
			process.stdout.write(`  ${r.repo}  ${theme.muted(`hook=${id}`)}\n`);
		}
		return 0;
	}

	private async runDoctor(): Promise<number> {
		const res = await daemonFetch('/api/repos/doctor', {
			method: 'POST',
			body: JSON.stringify({ clean: this.clean }),
			timeout: 30000, // listing hooks across many repos can be slow
		});
		if (!res) {
			ui.error('Daemon not reachable.');
			return 1;
		}
		const data = (await res.json()) as DoctorResponse;
		if (data.orphans.length === 0) {
			ui.success('No orphan webhooks found.');
			return 0;
		}
		ui.heading(`${data.orphans.length} orphan webhook(s):`);
		for (const o of data.orphans) {
			process.stdout.write(`  ${o.repo}  ${theme.muted(`id=${o.hookId} url=${o.url}`)}\n`);
		}
		if (this.clean) {
			ui.success(`Deleted ${data.deleted} of ${data.orphans.length} orphan(s).`);
		} else {
			ui.info('Run with `--clean` to delete them.');
		}
		return 0;
	}
}
