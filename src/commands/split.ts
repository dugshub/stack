import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command, Option } from 'clipanion';
import { descriptionToTitle, validateStackName } from '../lib/branch.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import type { FileStats, SplitPlan } from '../lib/split.js';
import { buildSplitPlan, parseSplitArgs } from '../lib/split.js';
import { loadState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class SplitCommand extends Command {
	static override paths = [['split']];

	static override usage = Command.Usage({
		description: 'Split uncommitted changes into a stacked set of branches',
		examples: [
			[
				'Split by file patterns',
				'stack split "api:src/lib/gh.ts" "server:src/server/**"',
			],
			[
				'Preview the plan',
				'stack split --dry-run "api:src/lib/gh.ts" "server:src/server/**"',
			],
			[
				'With negation patterns',
				'stack split "server:src/server/**:!src/server/test.ts"',
			],
		],
	});

	specs = Option.Rest({ required: 1 });

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show the plan without executing',
	});

	name = Option.String('--name,-n', {
		description: 'Stack name (kebab-case)',
	});

	async execute(): Promise<number> {
		// Validate: must have dirty files
		const dirtyFiles = git.allDirtyFiles();
		if (dirtyFiles.length === 0) {
			ui.error('No uncommitted changes to split.');
			return 2;
		}

		// Validate: not in a restack
		const state = loadState();
		for (const stack of Object.values(state.stacks)) {
			if (stack.restackState) {
				ui.error(
					`A restack is in progress. Use ${theme.command('stack restack --continue')} or ${theme.command('stack restack --abort')} first.`,
				);
				return 2;
			}
		}

		// Validate: no existing stack-split-temp stash
		const stashList = git.tryRun('stash', 'list');
		if (stashList.ok && stashList.stdout.includes('stack-split-temp')) {
			ui.error(
				'A previous split stash exists. Run `git stash drop` to clean up the "stack-split-temp" entry first.',
			);
			return 2;
		}

		// Determine stack name
		const stackName = this.resolveStackName();
		if (!stackName) return 2;

		// Validate stack name
		const validation = validateStackName(stackName);
		if (!validation.valid) {
			ui.error(validation.error ?? 'Invalid stack name');
			return 2;
		}

		// Validate: stack must not already exist
		if (state.stacks[stackName]) {
			ui.error(`Stack "${stackName}" already exists.`);
			return 2;
		}

		// Parse split specs
		let entries;
		try {
			entries = parseSplitArgs(this.specs);
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		if (entries.length === 0) {
			ui.error('No valid split specs provided.');
			return 2;
		}

		// Build plan
		const user = gh.currentUser();
		const trunk = git.defaultBranch();
		const plan = buildSplitPlan({
			stackName,
			trunk,
			user,
			entries,
		});

		if (plan.entries.length === 0) {
			ui.error('No files matched any of the provided patterns.');
			return 2;
		}

		// Warn about entries that matched nothing
		const matchedDescriptions = new Set(
			plan.entries.map((e) => e.branchDescription),
		);
		for (const entry of entries) {
			if (!matchedDescriptions.has(entry.branchDescription)) {
				ui.warn(
					`Pattern "${entry.branchDescription}" matched no files — skipping.`,
				);
			}
		}

		// Render plan
		this.renderPlan(plan);

		if (this.dryRun) {
			process.stderr.write('\n');
			ui.info(
				`Dry run — no changes made. Remove ${theme.command('--dry-run')} to execute.`,
			);
			return 0;
		}

		// Execute
		return this.executePlan(plan, state);
	}

	private resolveStackName(): string | null {
		if (this.name) return this.name;

		// Try to derive from current branch
		const current = git.currentBranch();
		const trunk = git.defaultBranch();
		if (current !== trunk) {
			// Use the last segment of the branch name
			const parts = current.split('/');
			const last = parts[parts.length - 1];
			if (last) return last;
		}

		ui.error(
			`Stack name required. Use ${theme.command('--name,-n')} to specify one.`,
		);
		return null;
	}

	private renderPlan(plan: SplitPlan): void {
		process.stderr.write('\n');
		process.stderr.write(
			`  ${theme.label(`Split Plan for stack "${plan.stackName}"`)}\n`,
		);
		process.stderr.write(
			`  ${'═'.repeat(56)}\n`,
		);

		for (let i = 0; i < plan.entries.length; i++) {
			const entry = plan.entries[i];
			if (!entry) continue;
			process.stderr.write('\n');

			// Entry header with branch name and totals
			const addStr = theme.success(`+${entry.totalAdded}`);
			const removeStr = theme.error(`-${entry.totalRemoved}`);
			const branchLabel = theme.branch(entry.branchName);
			process.stderr.write(
				`  ${i + 1}. ${branchLabel}  ${addStr}  ${removeStr}\n`,
			);

			// Group files by directory
			const byDir = this.groupByDirectory(entry.files);
			for (const [dir, files] of byDir) {
				process.stderr.write(`     ${theme.muted(dir)}\n`);
				for (const file of files) {
					const fileName = file.path.split('/').pop() ?? file.path;
					const newMarker = file.isNew ? ' (new)' : '';
					const fAddStr = theme.success(`+${file.added}`);
					const fRemoveStr = theme.error(`-${file.removed}`);
					process.stderr.write(
						`       ${fileName}${newMarker}  ${fAddStr}  ${fRemoveStr}\n`,
					);
				}
			}
		}

		// Separator
		process.stderr.write('\n');
		process.stderr.write(
			`  ${'─'.repeat(56)}\n`,
		);

		// Totals
		const addStr = theme.success(`+${plan.totalAdded}`);
		const removeStr = theme.error(`-${plan.totalRemoved}`);
		const modifiedFiles = plan.totalFiles - plan.newFiles;
		const fileBreakdown = [
			plan.newFiles > 0 ? `${plan.newFiles} new` : '',
			modifiedFiles > 0 ? `${modifiedFiles} modified` : '',
		]
			.filter(Boolean)
			.join(', ');

		process.stderr.write(`  Total  ${addStr}  ${removeStr}\n`);
		process.stderr.write(
			`  Files: ${plan.totalFiles}${fileBreakdown ? ` (${fileBreakdown})` : ''}\n`,
		);

		// Unassigned
		if (plan.unassigned.length > 0) {
			process.stderr.write('\n');
			const totalUnassignedAdded = plan.unassigned.reduce(
				(sum, f) => sum + f.added,
				0,
			);
			const totalUnassignedRemoved = plan.unassigned.reduce(
				(sum, f) => sum + f.removed,
				0,
			);
			ui.warn(
				`Unassigned changes (${plan.unassigned.length} file${plan.unassigned.length === 1 ? '' : 's'}):`,
			);
			for (const file of plan.unassigned) {
				const newMarker = file.isNew ? ' (new)' : '';
				const fAddStr = theme.success(`+${file.added}`);
				const fRemoveStr = theme.error(`-${file.removed}`);
				process.stderr.write(
					`     ${file.path}${newMarker}  ${fAddStr}  ${fRemoveStr}\n`,
				);
			}
		}
	}

	private groupByDirectory(
		files: FileStats[],
	): Map<string, FileStats[]> {
		const groups = new Map<string, FileStats[]>();
		for (const file of files) {
			const parts = file.path.split('/');
			const dir =
				parts.length > 1
					? `${parts.slice(0, -1).join('/')}/`
					: './';
			const existing = groups.get(dir) ?? [];
			existing.push(file);
			groups.set(dir, existing);
		}
		return groups;
	}

	private executePlan(
		plan: SplitPlan,
		state: ReturnType<typeof loadState>,
	): number {
		const repoRoot = git.repoRoot();

		// Step 1: Read all dirty file contents into memory
		const allDirty = git.allDirtyFiles();
		const fileContents = new Map<string, Buffer | null>();
		for (const file of allDirty) {
			try {
				const fullPath = join(repoRoot, file);
				fileContents.set(file, readFileSync(fullPath));
			} catch {
				// File was deleted
				fileContents.set(file, null);
			}
		}

		// Step 2: Stash everything
		git.stashPush({ includeUntracked: true, message: 'stack-split-temp' });

		// Step 3: Create branches
		const createdBranches: string[] = [];
		const trunk = plan.trunk;

		try {
			for (let i = 0; i < plan.entries.length; i++) {
				const entry = plan.entries[i];
				if (!entry) continue;

				// Create branch from the appropriate base
				if (i === 0) {
					// First branch: create from trunk
					git.checkout(trunk);
					git.createBranch(entry.branchName);
				} else {
					// Subsequent branches: create from previous branch
					const prevEntry = plan.entries[i - 1];
					if (!prevEntry) continue;
					git.createBranch(entry.branchName);
				}
				createdBranches.push(entry.branchName);

				// Reset working tree to clean slate
				git.cleanWorkingTree();

				// Write only this entry's files
				for (const fileStat of entry.files) {
					const content = fileContents.get(fileStat.path);
					if (content === null) {
						// Deleted file — git rm
						git.tryRun('rm', '-f', fileStat.path);
					} else if (content !== undefined) {
						const fullPath = join(repoRoot, fileStat.path);
						mkdirSync(dirname(fullPath), { recursive: true });
						writeFileSync(fullPath, content);
					}
				}

				// Stage the files
				const filePaths = entry.files.map((f) => f.path);
				git.run('add', ...filePaths);

				// Verify something is staged
				const diffResult = git.tryRun('diff', '--cached', '--quiet');
				if (diffResult.ok) {
					// Nothing staged — skip this branch
					ui.warn(
						`Nothing to commit for "${entry.branchDescription}" — skipping.`,
					);
					git.checkout(trunk);
					git.tryRun('branch', '-D', entry.branchName);
					createdBranches.pop();
					continue;
				}

				// Commit
				const title = descriptionToTitle(entry.branchDescription);
				git.run('commit', '-m', title);

				ui.success(
					`Created ${theme.branch(entry.branchName)} (${entry.files.length} file${entry.files.length === 1 ? '' : 's'})`,
				);
			}

			// Save stack state
			if (!state.repo) {
				state.repo = gh.repoFullName();
			}
			const now = new Date().toISOString();
			state.stacks[plan.stackName] = {
				trunk,
				branches: createdBranches.map((name) => ({
					name,
					tip: git.revParse(name),
					pr: null,
				})),
				created: now,
				updated: now,
				restackState: null,
			};
			saveState(state);
		} catch (err) {
			// Rollback: delete created branches, restore stash
			ui.error(
				`Split failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			process.stderr.write('\n');
			ui.info('Rolling back...');

			git.checkout(trunk);
			for (const branch of createdBranches) {
				git.tryRun('branch', '-D', branch);
			}

			// Pop stash to restore original state
			git.stashPop();

			// Remove stack from state if we partially created it
			if (state.stacks[plan.stackName]) {
				delete state.stacks[plan.stackName];
				saveState(state);
			}

			return 1;
		}

		// Step 4: Restore unassigned files + drop stash (wrapped for safety)
		try {
			if (plan.unassigned.length > 0) {
				for (const file of plan.unassigned) {
					const content = fileContents.get(file.path);
					if (content === null) {
						// Deleted file — nothing to restore
						continue;
					}
					if (content !== undefined) {
						const fullPath = join(repoRoot, file.path);
						mkdirSync(dirname(fullPath), { recursive: true });
						writeFileSync(fullPath, content);
					}
				}
				process.stderr.write('\n');
				ui.info(
					`Restored ${plan.unassigned.length} unassigned file${plan.unassigned.length === 1 ? '' : 's'} to working tree.`,
				);
			}
		} finally {
			// Always drop the stash, even if file restore fails
			git.stashDrop('stack-split-temp');
		}

		// Report
		process.stderr.write('\n');
		ui.success(
			`Created stack ${theme.stack(plan.stackName)} with ${createdBranches.length} branch${createdBranches.length === 1 ? '' : 'es'}.`,
		);
		return 0;
	}
}
