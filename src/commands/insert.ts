import * as p from '@clack/prompts';
import { Command, Option } from 'clipanion';
import { buildBranchName, toKebabCase } from '../lib/branch.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { cascadeRebase } from '../lib/rebase.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState, saveState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import { saveSnapshot } from '../lib/undo.js';
import * as ui from '../lib/ui.js';

export class InsertCommand extends Command {
	static override paths = [['branch', 'insert'], ['insert']];

	static override usage = Command.Usage({
		description: 'Insert a new branch at a position in the stack',
		examples: [
			['Insert after position 2', 'st insert --after 2'],
			[
				'Insert with description',
				'st insert --after 2 -d add-types',
			],
			['Insert before position 3', 'st insert --before 3'],
			['Preview the insert', 'st insert --dry-run --after 2'],
		],
	});

	stackName = Option.String('--stack,-s', {
		description: 'Target stack by name',
	});

	after = Option.String('--after', {
		description: 'Insert after this position (1-indexed)',
	});

	before = Option.String('--before', {
		description: 'Insert before this position (1-indexed)',
	});

	description = Option.String('--description,-d', {
		description: 'Branch description (used in branch name)',
	});

	dryRun = Option.Boolean('--dry-run', false, {
		description: 'Show what would happen without making changes',
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackName });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName: resolvedName, stack } = resolved;

		// Pre-flight checks
		if (git.isDirty()) {
			ui.error('Working tree is dirty. Commit or stash changes first.');
			return 2;
		}

		if (stack.restackState) {
			ui.error(
				`Restack in progress. Run ${theme.command('st continue')} or ${theme.command('st abort')} first.`,
			);
			return 2;
		}

		// Validate position args (mutually exclusive)
		if (this.after != null && this.before != null) {
			ui.error('Use --after or --before, not both.');
			return 2;
		}
		if (this.after == null && this.before == null) {
			ui.error('Specify a position with --after N or --before N.');
			return 2;
		}

		// Resolve insert index (0-indexed)
		let insertIndex: number;
		if (this.after != null) {
			const afterNum = Number.parseInt(this.after, 10);
			if (Number.isNaN(afterNum) || afterNum < 1 || afterNum > stack.branches.length) {
				ui.error(
					`Invalid --after value "${this.after}". Use 1-${stack.branches.length} (1-indexed).`,
				);
				return 2;
			}
			// --after N means insert after position N (1-indexed), so insertIndex = N
			insertIndex = afterNum;
		} else {
			const beforeNum = Number.parseInt(this.before!, 10);
			if (Number.isNaN(beforeNum) || beforeNum < 1 || beforeNum > stack.branches.length + 1) {
				ui.error(
					`Invalid --before value "${this.before}". Use 1-${stack.branches.length + 1}.`,
				);
				return 2;
			}
			// --before 1 means insert at the bottom (index 0)
			insertIndex = beforeNum - 1;
		}

		// Get description
		let description = this.description;
		if (!description) {
			if (!process.stderr.isTTY) {
				ui.error('Description required in non-interactive mode. Use -d <description>.');
				return 2;
			}
			const result = await p.text({
				message: 'Branch description:',
				placeholder: 'e.g. add-types',
				validate: (val) => {
					if (!val || val.trim().length === 0) return 'Description cannot be empty';
					return undefined;
				},
			});
			if (p.isCancel(result)) {
				return 0;
			}
			description = result;
		}

		const kebabDescription = toKebabCase(description);

		// Dry-run: show where new branch will be inserted
		if (this.dryRun) {
			ui.heading('Current order:');
			for (let i = 0; i < stack.branches.length; i++) {
				const b = stack.branches[i];
				if (!b) continue;
				ui.info(`  ${i + 1}. ${b.name}`);
			}

			ui.heading('New order:');
			let pos = 1;
			for (let i = 0; i < stack.branches.length; i++) {
				if (i === insertIndex) {
					ui.info(`  ${pos}. <new: ${kebabDescription}> (inserted)`);
					pos++;
				}
				const b = stack.branches[i];
				if (!b) continue;
				ui.info(`  ${pos}. ${b.name}`);
				pos++;
			}
			if (insertIndex === stack.branches.length) {
				ui.info(`  ${pos}. <new: ${kebabDescription}> (inserted)`);
			}
			return 0;
		}

		saveSnapshot('insert');

		// Build oldTips BEFORE mutation
		const oldTips: Record<string, string> = {};
		for (const branch of stack.branches) {
			oldTips[branch.name] = branch.tip ?? git.revParse(branch.name);
		}

		// Determine parent
		const parentBranch = insertIndex > 0 ? stack.branches[insertIndex - 1] : null;
		const parentRef = parentBranch?.name ?? stack.trunk;
		const parentTip = git.revParse(parentRef);

		// Build branch name
		const user = gh.currentUser();
		const branchName = buildBranchName(
			user,
			resolvedName,
			insertIndex + 1,
			kebabDescription,
		);

		// Create branch at parent tip and check it out
		git.branchCreate(branchName, parentTip);
		git.checkout(branchName);

		// Splice into state
		stack.branches.splice(insertIndex, 0, {
			name: branchName,
			tip: parentTip,
			pr: null,
			parentTip,
		});

		// Update PR bases for downstream branches
		for (let i = insertIndex + 1; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch?.pr) continue;
			const newBase =
				i === 0
					? stack.trunk
					: (stack.branches[i - 1]?.name ?? stack.trunk);
			try {
				gh.prEdit(branch.pr, { base: newBase });
			} catch {
				ui.warn(`Failed to update PR base for #${branch.pr}`);
			}
		}

		// Cascade rebase for downstream branches (if any)
		if (insertIndex + 1 < stack.branches.length) {
			const cascadeResult = cascadeRebase({
				state,
				stack,
				fromIndex: insertIndex,
				startIndex: insertIndex + 1,
				worktreeMap: git.worktreeList(),
				oldTips,
			});

			if (!cascadeResult.ok) {
				return 1;
			}
		}

		stack.updated = new Date().toISOString();
		saveState(state);

		ui.success(
			`Inserted ${theme.branch(branchName)} at position ${insertIndex + 1} in stack ${theme.stack(resolvedName)}.`,
		);
		ui.warn('New branch is empty — add commits before submitting.');
		return 0;
	}
}
