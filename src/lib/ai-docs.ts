/**
 * AI-friendly documentation for `stack --ai [command]`.
 * Plain text, no ANSI, structured for LLM consumption.
 */

interface CommandDoc {
	description: string;
	flags?: string[];
	examples?: string[];
	details?: string;
}

const commands: Record<string, CommandDoc> = {
	create: {
		description: 'Create a new stack or adopt existing branches',
		flags: [
			'<name>           Stack name (kebab-case). Auto-detected from branch if omitted.',
			'--description,-d First branch description',
			'--from           Adopt existing branches (space-separated)',
		],
		examples: [
			'stack create frozen-column',
			'stack create frozen-column --description sticky-header',
			'stack create frozen-column --from branch1 branch2',
			'stack create   # auto-detect from current branch name',
		],
		details:
			'Creates a stack rooted at the current trunk (main/master). If --from is given, adopts existing branches in order. Otherwise creates the first branch from HEAD. Branch names follow the pattern: user/stack-name/N-description.',
	},
	delete: {
		description: 'Remove a stack from tracking',
		flags: [
			'<name>       Stack name (interactive picker if omitted)',
			'--branches   Also delete the git branches',
			'--prs        Also close open PRs',
		],
		examples: [
			'stack delete my-stack',
			'stack delete my-stack --branches --prs',
		],
		details:
			'Removes the stack from state. By default only removes tracking — branches and PRs are left intact. Use --branches and --prs to clean up fully.',
	},
	status: {
		description: 'Show current stack status with branch and PR info',
		flags: [
			'--stack,-s   Target stack by name',
			'--json       Output as JSON to stdout',
		],
		examples: ['stack status', 'stack status --json'],
		details:
			'Shows each branch in the stack with its position, PR number, PR status (draft/open/merged/closed), and review state. The current branch is highlighted.',
	},
	nav: {
		description: 'Navigate between branches in the stack',
		flags: ['--stack,-s   Target stack by name'],
		examples: [
			'stack nav         # interactive branch picker',
			'stack nav 3       # jump to branch 3',
			'stack nav up      # move toward trunk',
			'stack nav down    # move away from trunk',
			'stack nav top     # go to tip of stack',
			'stack nav bottom  # go to base of stack',
			'stack 3           # shorthand for stack nav 3',
		],
		details:
			'Bare `stack nav` opens an interactive picker. Numeric args are 1-based branch positions. `up` goes toward trunk (lower index), `down` goes toward tip (higher index).',
	},
	track: {
		description: 'Add the current branch to a stack',
		flags: ['--stack,-s   Stack name (if not on a stack branch)'],
		examples: ['stack track', 'stack track --stack frozen-column'],
		details:
			'Appends the current git branch to the top of the stack. The branch must not already be in a stack.',
	},
	remove: {
		description: 'Remove a branch from the active stack',
		flags: [
			'<branch>     Branch name (defaults to current branch)',
			'--stack,-s   Target stack by name',
			'--branch     Also delete the git branch',
			'--pr         Also close the PR',
		],
		examples: [
			'stack remove',
			'stack remove user/stack/2-feature',
			'stack remove --branch --pr',
		],
		details:
			'Removes a branch from the stack ordering. Downstream branches are re-parented to the removed branch\'s parent. Does not delete the git branch or close the PR unless flags are given.',
	},
	submit: {
		description: 'Push all branches and create/update PRs for the stack',
		flags: [
			'--stack,-s   Target stack by name',
			'--dry-run    Show what would happen without pushing or creating PRs',
		],
		examples: ['stack submit', 'stack submit --dry-run'],
		details:
			'For each branch in the stack: force-pushes with --force-with-lease, creates a PR (if none exists) targeting the parent branch, updates existing PR base branches, and posts a stack navigation comment on each PR. PR titles are derived from branch names: user/stack-name/1-add-schema -> "Add Schema".',
	},
	absorb: {
		description: 'Route uncommitted changes to the correct stack branches',
		flags: [
			'--stack,-s     Target stack by name',
			'--dry-run      Show the plan without executing',
			'--branch,-b N  Route positional files to branch N (1-based)',
			'-m,--message   Commit message for absorbed changes',
			'<files...>     Files to route (used with --branch)',
		],
		examples: [
			'stack absorb --dry-run        # preview routing plan',
			'stack absorb                  # auto-route clean files',
			'stack absorb --branch 5 GroupedTable.tsx   # manual routing',
			'stack absorb -m "fix typos"',
		],
		details:
			'Determines which stack branch "owns" each dirty file by checking git diff history. Files owned by exactly one branch are auto-routed. Files owned by multiple branches (conflicted) or no branch (unowned) are skipped and restored to the working tree. Use --branch N to manually route conflicted/unowned files. After committing, downstream branches are rebased automatically.',
	},
	restack: {
		description: 'Rebase downstream branches after amending a stack branch',
		flags: [
			'--stack,-s   Target stack by name',
		],
		examples: [
			'stack restack',
		],
		details:
			'When you amend a commit on a mid-stack branch, downstream branches become stale. Restack rebases each downstream branch onto its updated parent, preserving the stack chain. If a rebase conflict occurs, resolve it and run `stack continue`.',
	},
	continue: {
		description: 'Continue a paused restack after resolving conflicts',
		flags: [],
		examples: [
			'stack continue',
		],
		details:
			'After a restack hits a conflict, resolve the conflicts, stage the files, then run `stack continue` to resume rebasing the remaining branches.',
	},
	abort: {
		description: 'Abort an in-progress restack',
		flags: [],
		examples: [
			'stack abort',
		],
		details:
			'Aborts a restack that is paused due to conflicts. The current rebase is aborted and branches after the conflict point remain in their pre-restack state.',
	},
	sync: {
		description: 'Clean up after PRs are merged on GitHub',
		flags: ['--stack,-s   Target stack by name'],
		examples: ['stack sync'],
		details:
			'Fetches from origin, detects which stack branches have been merged into trunk, removes them from the stack, and rebases remaining branches. Handles GitHub\'s squash-merge by matching commit subjects. Run this after merging PRs.',
	},
	merge: {
		description: 'Merge the entire stack bottom-up via GitHub API',
		flags: [
			'--all        Merge all PRs bottom-up (required)',
			'--dry-run    Show merge plan without executing',
			'--status     Show active merge job status',
			'--setup      Configure webhook for auto-merge orchestration',
			'--stack,-s   Target stack by name',
		],
		examples: [
			'stack merge --all',
			'stack merge --dry-run',
			'stack merge --status',
			'stack merge --setup',
		],
		details:
			'Merges PRs sequentially from bottom to top using squash-merge. Each PR must pass CI checks before merging. After each merge, the next PR\'s base is updated. Uses a webhook-driven server for orchestration — run --setup first to configure.',
	},
	split: {
		description: 'Split uncommitted changes into a stacked set of branches',
		flags: [
			'<specs...>   Branch specs: "name:pattern1:pattern2:!negation"',
			'--dry-run    Preview the split plan',
			'--name,-n    Stack name (kebab-case)',
		],
		examples: [
			'stack split "api:src/lib/gh.ts" "server:src/server/**"',
			'stack split --dry-run "api:src/lib/gh.ts" "server:src/server/**"',
			'stack split "server:src/server/**:!src/server/test.ts"',
		],
		details:
			'Takes uncommitted changes and distributes them across new branches based on file patterns. Each spec is "branch-description:glob1:glob2:!negation". Files matching no spec go to a remainder branch. Creates a new stack with the branches.',
	},
	undo: {
		description: 'Restore stack state to before the last mutating command',
		flags: [
			'--list       Show available restore points',
			'--steps N    How many operations to undo (default: 1)',
			'--dry-run    Preview without applying',
		],
		examples: [
			'stack undo',
			'stack undo --steps 3',
			'stack undo --list',
			'stack undo --dry-run',
		],
		details:
			'Every mutating command (absorb, restack, sync, submit, push, remove, split, merge) saves a snapshot. Undo restores git branch refs and stack state to a previous snapshot. Does not undo pushed changes on the remote.',
	},
	init: {
		description: 'Install Claude Code skills for stack management',
		examples: ['stack init'],
		details:
			'Copies the stack management skill files into the current project\'s .claude/skills/ directory so Claude Code can use `stack` commands natively.',
	},
	update: {
		description: 'Self-update to the latest version from GitHub',
		examples: ['stack update'],
		details: 'Fetches and installs the latest version via bun.',
	},
};

const overview = `stack — Stacked PRs for GitHub

A CLI tool for managing stacked PRs. Branches form an ordered stack where each PR targets the branch below it (or trunk). All state is stored in ~/.claude/stacks/<repo>.json.

CORE CONCEPTS:
- Stack: An ordered list of branches, rooted at trunk (main/master)
- Branch position: 1-based index in the stack. Branch 1 is closest to trunk.
- Trunk: The base branch (main/master) that the stack builds on
- Navigation: \`stack <number>\` jumps to branch N, \`stack <name>\` switches stacks
- PR targeting: Each PR targets its parent branch (or trunk for branch 1)
- Restacking: After editing a mid-stack branch, downstream branches need rebasing

TYPICAL WORKFLOW:
  stack create my-feature          # start a stack
  # ... write code on branch 1 ...
  stack submit                     # push + create PRs
  stack nav down                   # move to branch 2
  # ... write more code ...
  stack submit                     # push all + update all PRs
  stack merge --all                # merge bottom-up when approved
  stack sync                       # clean up after merge

COMMANDS:`;

export function printAiDocs(command?: string): void {
	if (command && commands[command]) {
		printCommandDoc(command, commands[command]!);
	} else if (command) {
		process.stdout.write(`Unknown command: ${command}\n`);
		process.stdout.write(`Available commands: ${Object.keys(commands).join(', ')}\n`);
	} else {
		printOverview();
	}
}

function printOverview(): void {
	process.stdout.write(overview + '\n');

	for (const [name, doc] of Object.entries(commands)) {
		process.stdout.write(`  stack ${name.padEnd(12)} ${doc.description}\n`);
	}

	process.stdout.write('\nTIP: Run `stack <command> --ai` for detailed docs on any command.\n');
	process.stdout.write('TIP: Run `stack <command> -h` for standard help.\n');
}

function printCommandDoc(name: string, doc: CommandDoc): void {
	process.stdout.write(`stack ${name} — ${doc.description}\n`);

	if (doc.flags && doc.flags.length > 0) {
		process.stdout.write('\nFLAGS:\n');
		for (const flag of doc.flags) {
			process.stdout.write(`  ${flag}\n`);
		}
	}

	if (doc.examples && doc.examples.length > 0) {
		process.stdout.write('\nEXAMPLES:\n');
		for (const ex of doc.examples) {
			process.stdout.write(`  ${ex}\n`);
		}
	}

	if (doc.details) {
		process.stdout.write('\nDETAILS:\n');
		process.stdout.write(`  ${doc.details}\n`);
	}
}
