import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';
import type { Branch, CheckResult } from '../lib/types.js';

export class CheckCommand extends Command {
	static override paths = [['stack', 'check'], ['check']];

	static override usage = Command.Usage({
		description: 'Run a command on every branch in the stack',
		examples: [
			['Type-check all branches', 'st check bun tsc --noEmit'],
			['Stop on first failure', 'st check --bail npm test'],
			['Start from branch 5', 'st check --from 5 make build'],
		],
	});

	stackName = Option.String('--stack,-s', { description: 'Target stack by name' });
	from = Option.String('--from', { description: 'Start from branch N (1-indexed)' });
	bail = Option.Boolean('--bail', false, { description: 'Stop on first failure' });
	json = Option.Boolean('--json', false, { description: 'Output as JSON to stdout' });
	quiet = Option.Boolean('--quiet,-q', false, { description: 'Suppress command output' });
	command = Option.Rest({ required: 1 });

	async execute(): Promise<number> {
		const state = loadAndRefreshState();

		// 1. Resolve stack
		let resolved;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackName });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName, stack } = resolved;
		const cmdStr = this.command.join(' ');

		// 2. Parse --from, validate range
		const fromIndex = this.from ? parseInt(this.from, 10) : 1;
		if (isNaN(fromIndex) || fromIndex < 1 || fromIndex > stack.branches.length) {
			ui.error(`--from must be between 1 and ${stack.branches.length}`);
			return 2;
		}
		const branches = stack.branches.slice(fromIndex - 1);

		// 3. Print banner (unless JSON)
		if (!this.json) {
			ui.heading(`\nChecking stack: ${theme.stack(stackName)} (${stack.branches.length} branches)`);
			ui.info(`Running: ${cmdStr}\n`);
		}

		// 4. Run checks
		const results = runSequential(branches, this.command, fromIndex, {
			bail: this.bail,
			quiet: this.quiet || this.json, // suppress output in JSON mode too
		});

		// 5. Output results
		if (this.json) {
			const passed = results.filter(r => r.ok).length;
			const failed = results.filter(r => !r.ok).length;
			const output = {
				stack: stackName,
				command: cmdStr,
				results,
				passed,
				failed,
				total: results.length,
			};
			process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
		} else {
			ui.checkResultsTable(results);
			const failed = results.filter(r => !r.ok).length;
			if (failed > 0) {
				process.stderr.write(`\n${theme.error(`${failed} of ${results.length} failed`)}\n\n`);
			} else {
				process.stderr.write(`\n${theme.success(`All ${results.length} passed`)}\n\n`);
			}
		}

		// 6. Exit code
		return results.some(r => !r.ok) ? 1 : 0;
	}
}

function runSequential(
	branches: Branch[],
	command: string[],
	startIndex: number,
	opts: { bail: boolean; quiet: boolean },
): CheckResult[] {
	const originalBranch = git.currentBranch();
	const wasDirty = git.isDirty();

	if (wasDirty) {
		try {
			git.stashPush({ includeUntracked: true, message: 'stack-check-stash' });
		} catch {
			ui.error('Failed to stash dirty working tree. Commit or stash manually first.');
			return [];
		}
	}

	const results: CheckResult[] = [];
	try {
		for (let i = 0; i < branches.length; i++) {
			const branch = branches[i]!;
			const branchIndex = startIndex + i; // 1-indexed position in full stack

			git.checkout(branch.name);

			const start = performance.now();
			const result = Bun.spawnSync(['sh', '-c', command.join(' ')], {
				stdout: opts.quiet ? 'pipe' : 'inherit',
				stderr: opts.quiet ? 'pipe' : 'inherit',
			});
			const durationMs = performance.now() - start;

			results.push({
				branch: branch.name,
				index: branchIndex,
				exitCode: result.exitCode,
				ok: result.exitCode === 0,
				durationMs,
			});

			if (opts.bail && result.exitCode !== 0) break;
		}
	} finally {
		git.tryRun('checkout', originalBranch);
		if (wasDirty) {
			try { git.stashPop(); } catch { /* stash may have been consumed */ }
		}
	}
	return results;
}
