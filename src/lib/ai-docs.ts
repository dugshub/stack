/**
 * AI-friendly documentation for `st --ai [command]`.
 * Plain text, no ANSI, structured for LLM consumption.
 */

interface CommandDoc {
	description: string;
	group?: 'stack' | 'branch';
	flags?: string[];
	examples?: string[];
	details?: string;
}

const commands: Record<string, CommandDoc> = {
	create: {
		description: 'Create a new stack or adopt existing branches',
		group: 'stack',
		flags: [
			'<name>           Stack name (kebab-case). Auto-detected from branch if omitted.',
			'--description,-d First branch description',
			'--from           Adopt existing branches (space-separated)',
			'--base,-b        Base on another branch (dependent stack). Use "." for the current branch.',
			'--also-base      Additional parent branch to join via a merge commit (diamond). Repeatable.',
			'--yes,-y         Skip confirmation prompts (non-interactive).',
		],
		examples: [
			'st create frozen-column',
			'st create frozen-column --description sticky-header',
			'st create frozen-column --from branch1 branch2',
			'st create   # auto-detect from current branch name',
			'st create cache -b user/other-stack/3-final -d initial   # dependent stack',
			'st create cache -b .                                      # dependent on current branch',
			'st create join -b feat/2-api --also-base feat-alt/1-schema -d merge   # diamond',
		],
		details:
			'Creates a stack rooted at the current trunk (main/master). With --from, adopts existing branches in order; otherwise creates the first branch from HEAD. With --base, builds a dependent stack on another branch (records dependsOn); --also-base adds extra parents joined via a merge commit (diamond stack). Branch names follow user/stack-name/N-description.',
	},
	delete: {
		description: 'Remove a stack from tracking',
		group: 'stack',
		flags: [
			'<name>       Stack name (interactive picker if omitted)',
			'--branches   Also delete the git branches',
			'--prs        Also close open PRs',
		],
		examples: [
			'st delete my-stack',
			'st delete my-stack --branches --prs',
		],
		details:
			'Removes the stack from state. By default only removes tracking — branches and PRs are left intact. Use --branches and --prs to clean up fully.',
	},
	status: {
		description: 'Show current stack status with branch and PR info',
		group: 'stack',
		flags: [
			'--stack,-s   Target stack by name',
			'--json       Output as JSON to stdout',
		],
		examples: ['st status', 'st status --json'],
		details:
			'Shows each branch in the stack with its position, PR number, PR status (draft/open/merged/closed), and review state. The current branch is highlighted. It also surfaces repo-watch drift: if `state.repo` differs from the origin remote slug (a GitHub rename/transfer left it stale) or the repo isn\'t watched by the daemon, it warns and points at `st daemon repo heal` (or, with `st config --auto-watch` enabled, silently fixes state.repo + registers the repo, one info line each). --json adds a `repoWatch: { stateSlug, remoteSlug, drifted, watched }` object (watched: null when unknown — no daemon token or daemon down); the watch probe is skipped entirely when no daemon token exists.',
	},
	submit: {
		description: 'Push all branches and create/update PRs for the stack',
		group: 'stack',
		flags: [
			'--stack,-s   Target stack by name',
			'--dry-run    Show what would happen without pushing or creating PRs',
			'--ready      Mark all PRs as ready for review (not draft)',
			'--describe   Generate PR descriptions with AI (needs `st login`; or `st config --describe`)',
			'--update     Regenerate AI descriptions for existing PRs',
		],
		examples: ['st submit', 'st submit --dry-run', 'st submit --ready', 'st submit --describe'],
		details:
			'For each branch in the stack: force-pushes with --force-with-lease, creates a PR (if none exists) targeting the parent branch, updates existing PR base branches, and posts a stack navigation comment on each PR. PRs are created as drafts; --ready marks them ready (staggered to preserve notification order). PR titles are derived from branch names: user/stack-name/1-add-schema -> "Add Schema". When `st config --auto-watch` is enabled and the daemon is running, submit also registers the repo with the daemon if it isn\'t already watched (one info line; off by default so submit latency is untouched).',
	},
	get: {
		description: 'Adopt the remote version of the stack (reset local branches to origin)',
		group: 'stack',
		flags: [
			'--stack,-s   Target stack by name',
			'--force      Adopt diverged branches too (discards local-only commits)',
			'--dry-run    Classify branches and print the plan without mutating anything',
		],
		examples: ['st get', 'st get --dry-run', 'st get --force'],
		details:
			'Fetches, then per stack branch adopts origin/<branch> over the local ref when it is safe: when local is strictly behind the remote (fast-forward) or the remote is a clean rebase of the same patches (the daemon-restacked case — every local-only commit is patch-equivalent to a remote one). Branches with real un-pushed local commits are kept and reported as diverged; pass --force to discard them and take the remote. A branch checked out in a dirty worktree (or the dirty current branch) is skipped with a commit-or-stash hint, even under --force. Also walks the dependency chain upward and adopts each ancestor stack first (root-down, resolved stack last) so a dependent stack whose parent the daemon rewrote stays ancestor-correct across the seam; --force applies ONLY to the resolved stack (a diverged branch in an ancestor warns with `st get -s <ancestor> --force`), and an ancestor with a restack in progress is skipped with a warning. Updates recorded tips and parentTips so subsequent restacks compute correct ranges, snapshots first (st undo reverts), and fast-forwards trunk. Use when a different session/worktree (or the daemon) already restacked and force-pushed and your local checkout is stale.',
	},
	sync: {
		description: 'Clean up after PRs are merged on GitHub',
		group: 'stack',
		flags: ['--stack,-s   Target stack by name'],
		examples: ['st sync'],
		details:
			'Fetches from origin, then auto-adopts remote branch refs that are strictly ahead or a clean rewrite of the same patches (the same safety predicate as st get) — so a stack the daemon already restacked + force-pushed is taken as-is instead of being re-rebased onto trunk (no duplicate rebase, no conflicts). The adoption walks the dependency chain upward too, adopting each ancestor stack before the resolved one (root-down), so a dependent stack whose parent the daemon rewrote needs nothing extra. Branches with real un-pushed local commits are kept and reported (run st get --force on the resolved stack, or st get -s <ancestor> --force for an ancestor, to discard them). Then detects which stack branches merged (matching commit subjects to handle squash-merge), removes them, fast-forwards trunk, and rebases the remaining branches. Also rebases the stack whenever trunk advanced on the remote even if no PR merged. Converts a dependent stack to standalone when its base merges.',
	},
	merge: {
		description: 'Merge stack PRs via auto-merge',
		group: 'stack',
		flags: [
			'--all        Enable auto-merge on all PRs bottom-up',
			'--now        Merge the current branch immediately (must target trunk)',
			'--dry-run    Show the merge plan without executing',
			'--stack,-s   Target stack by name',
		],
		examples: [
			'st merge',
			'st merge --all',
			'st merge --now',
			'st merge --dry-run',
		],
		details:
			'Bare `st merge` enables GitHub auto-merge on the current branch\'s PR. --all enables auto-merge bottom-up across the stack; the background daemon watches each merge, then rebases, retargets, and enables auto-merge on the next PR (and rebases dependent stacks). --now merges the current branch immediately via squash-merge (it must target trunk).',
	},
	comment: {
		description: 'Preview the stack navigation comment markdown',
		group: 'stack',
		flags: [
			'--stack,-s   Target stack by name',
			'--all        Preview comments for all branches in the stack',
		],
		examples: ['st comment', 'st comment --all'],
		details:
			'Prints the markdown that `st submit` posts as a navigation comment on each PR, without contacting GitHub. Shows upstream and downstream stacks in the chain. Useful for previewing how the stack will render.',
	},
	restack: {
		description: 'Rebase downstream branches after amending a stack branch',
		group: 'stack',
		flags: [
			'--stack,-s   Target stack by name',
		],
		examples: [
			'st restack',
		],
		details:
			'When you amend a commit on a mid-stack branch, downstream branches become stale. Restack rebases each downstream branch onto its updated parent, preserving the stack chain. If a rebase conflict occurs, resolve it and run `st continue`.',
	},
	base: {
		description: 'Change the stack’s base branch (re-parent)',
		group: 'stack',
		flags: [
			'<new-base>       New base: a branch name, "." for current branch, or a branch inside another stack',
			'--stack,-s       Target stack by name',
			'--dry-run        Show the re-parent plan without mutating',
			'--cascade        Cascade rebase to dependent stacks (default on)',
			'--no-cascade     Skip cascading to dependent stacks',
		],
		examples: [
			'st base main',
			'st base develop',
			'st base user/other-stack/3-final',
			'st base .',
			'st base --dry-run main',
		],
		details:
			'Re-parents an existing stack onto a different base branch. The inverse of `st create --base` at creation time. Updates `stack.trunk` (and `dependsOn` when the new base belongs to another stack), rebases every branch in the stack onto the new base, updates the first branch’s PR base on GitHub, and cascades to dependent stacks. Rejects cycles, self-reference, multi-parent stacks (phase 1), and in-progress restacks. On conflict, resolve and run `st continue`.',
	},
	check: {
		description: 'Run a command on every branch in the stack',
		group: 'stack',
		flags: [
			'--stack,-s   Target stack by name',
			'--from N     Start from branch N (1-indexed)',
			'--bail       Stop on first failure',
			'--json       Output as JSON to stdout',
		],
		examples: [
			'st check bun tsc --noEmit',
			'st check --bail npm test',
			'st check --from 5 make build',
		],
		details:
			'Checks out each branch in the stack and runs the given command. Reports pass/fail per branch. Useful for verifying that all branches build or pass tests.',
	},
	graph: {
		description: 'Show stack dependency graph',
		group: 'stack',
		flags: [
			'--all,-a     Show all stacks (default: current stack chain only)',
			'--expand,-e  Show all branches in each stack',
		],
		examples: [
			'st graph',
			'st graph --all',
			'st graph --expand',
		],
		details:
			'Shows the dependency relationships between stacks and their branches as a visual tree. The interactive graph (`st -i` / `st graph`) navigates with ↑↓/jk, checks out with enter, opens a PR with o, and quits with q. When repo-watch is unhealthy (slug drift or the repo isn\'t watched by the daemon) a banner appears at the top — press `w` to repair it in place (fixes state.repo and registers the repo with the daemon; same as status\'s auto-watch path, minus the origin-URL rewrite). Run `st daemon repo heal` for the full fix including the origin remote.',
	},
	up: {
		description: 'Move up one branch (toward trunk)',
		group: 'branch',
		flags: ['--stack,-s   Target stack by name'],
		examples: ['st up'],
		details: 'Checks out the branch one position closer to trunk in the current stack.',
	},
	down: {
		description: 'Move down one branch (away from trunk)',
		group: 'branch',
		flags: ['--stack,-s   Target stack by name'],
		examples: ['st down'],
		details: 'Checks out the branch one position further from trunk in the current stack.',
	},
	top: {
		description: 'Jump to the top of the stack',
		group: 'branch',
		flags: ['--stack,-s   Target stack by name'],
		examples: ['st top'],
		details: 'Checks out the branch furthest from trunk (highest index) in the stack.',
	},
	bottom: {
		description: 'Jump to the bottom of the stack',
		group: 'branch',
		flags: ['--stack,-s   Target stack by name'],
		examples: ['st bottom'],
		details: 'Checks out the branch closest to trunk (index 1) in the stack.',
	},
	nav: {
		description: 'Navigate between branches in the stack',
		group: 'branch',
		flags: ['--stack,-s   Target stack by name'],
		examples: [
			'st nav         # interactive branch picker',
			'st nav 3       # jump to branch 3',
			'st 3           # shorthand for st nav 3',
		],
		details:
			'Bare `st nav` opens an interactive picker. Numeric args are 1-based branch positions.',
	},
	track: {
		description: 'Add the current branch to a stack',
		group: 'branch',
		flags: ['--stack,-s   Stack name (if not on a stack branch)'],
		examples: ['st track', 'st track --stack frozen-column'],
		details:
			'Appends the current git branch to the top of the stack. The branch must not already be in a stack.',
	},
	remove: {
		description: 'Remove a branch from the active stack',
		group: 'branch',
		flags: [
			'<branch>     Branch name (defaults to current branch)',
			'--stack,-s   Target stack by name',
			'--branch     Also delete the git branch',
			'--pr         Also close the PR',
		],
		examples: [
			'st remove',
			'st remove user/stack/2-feature',
			'st remove --branch --pr',
		],
		details:
			'Removes a branch from the stack ordering. Downstream branches are re-parented to the removed branch\'s parent. Does not delete the git branch or close the PR unless flags are given.',
	},
	pop: {
		description: 'Remove current branch from stack, keeping changes in working tree',
		group: 'branch',
		flags: [
			'--close     Also close the PR if one exists',
		],
		examples: [
			'st pop',
			'st pop --close',
		],
		details:
			'Pops the current branch from the stack: computes the diff vs parent, checks out parent, applies the diff (staged, not committed), deletes the local branch. Downstream branches are re-parented.',
	},
	fold: {
		description: 'Merge current branch into its parent branch',
		group: 'branch',
		flags: [],
		examples: [
			'st fold',
		],
		details:
			'Folds the current branch into its parent: checks out the parent, merges (fast-forward preferred), closes the PR if one exists, deletes the branch (local + remote), and removes it from the stack. Downstream branches are restacked onto the parent. Cannot fold the bottom branch. If downstream restack hits conflicts, resolve them and run `st continue`.',
	},
	rename: {
		description: 'Rename the current branch in the stack',
		group: 'branch',
		flags: [
			'<new-name>      New description for the branch',
			'--no-pr-update   Skip updating the PR title',
		],
		examples: [
			'st rename new-description',
			'st rename new-description --no-pr-update',
		],
		details:
			'Renames the current stack branch locally and on the remote. Preserves the user/stack/N- prefix and replaces only the description portion. Updates the PR title to match.',
	},
	move: {
		description: 'Move a branch within the stack',
		group: 'branch',
		flags: [
			'<up|down|N>  Direction or target position (1-indexed)',
			'--stack,-s   Target stack by name',
			'--dry-run    Preview the move',
		],
		examples: [
			'st move up',
			'st move down',
			'st move 3',
			'st move --dry-run up',
		],
		details:
			'Repositions the current branch within the stack. `up` moves toward trunk, `down` moves away. Numeric arg sets the absolute position. Rebases affected branches automatically.',
	},
	insert: {
		description: 'Insert a new branch at a position in the stack',
		group: 'branch',
		flags: [
			'--after N         Insert after position N',
			'--before N        Insert before position N',
			'--description,-d  Branch description',
			'--stack,-s        Target stack by name',
			'--dry-run         Preview the insert',
		],
		examples: [
			'st insert --after 2',
			'st insert --after 2 -d add-types',
			'st insert --before 3',
		],
		details:
			'Creates an empty branch at the specified position. Downstream branches are rebased. Use --after or --before (mutually exclusive).',
	},
	reorder: {
		description: 'Reorder branches in the stack',
		group: 'branch',
		flags: [
			'<positions...>  New order as position numbers',
			'--stack,-s      Target stack by name',
			'--dry-run       Preview the reorder',
		],
		examples: [
			'st reorder 3 1 2 4',
			'st reorder --dry-run 3 1 2 4',
		],
		details:
			'Reorders branches by specifying the new position order. Must be a complete permutation. Run `st restack` after to rebase.',
	},
	modify: {
		description: 'Amend staged changes into the current commit and restack',
		group: 'branch',
		flags: [
			'--all,-a       Stage all changes before amending',
			'--message,-m   New commit message for the amended commit',
			'--no-restack   Skip restacking downstream branches',
		],
		examples: [
			'st modify                    # amend staged changes, restack',
			'st modify -a                 # stage all, amend, restack',
			'st modify -m "new message"   # amend with new commit message',
			'st modify --no-restack       # amend without restacking',
		],
		details:
			'Amends staged changes into the current commit (like git commit --amend) and automatically restacks downstream branches. If conflicts occur during restack, resolve them and run `st continue`.',
	},
	absorb: {
		description: 'Route uncommitted changes to the correct stack branches',
		group: 'branch',
		flags: [
			'--stack,-s     Target stack by name',
			'--dry-run      Show the plan without executing',
			'--branch,-b N  Route positional files to branch N (1-based)',
			'-m,--message   Commit message for absorbed changes',
			'<files...>     Files to route (used with --branch)',
		],
		examples: [
			'st absorb --dry-run        # preview routing plan',
			'st absorb                  # auto-route clean files',
			'st absorb --branch 5 GroupedTable.tsx   # manual routing',
			'st absorb -m "fix typos"',
		],
		details:
			'Determines which stack branch "owns" each dirty file by checking git diff history. Files owned by exactly one branch are auto-routed. Use --branch N for manual routing.',
	},
	split: {
		description: 'Split uncommitted changes into a stacked set of branches',
		group: 'branch',
		flags: [
			'<specs...>   Branch specs: "name:pattern1:pattern2:!negation"',
			'--dry-run    Preview the split plan',
			'--name,-n    Stack name (kebab-case)',
		],
		examples: [
			'st split "api:src/lib/gh.ts" "server:src/server/**"',
			'st split --dry-run "api:src/lib/gh.ts" "server:src/server/**"',
		],
		details:
			'Takes uncommitted changes and distributes them across new branches based on file patterns. Each spec is "branch-description:glob1:glob2:!negation". Creates a new stack with the branches.',
	},
	continue: {
		description: 'Continue a paused restack after resolving conflicts',
		flags: [],
		examples: ['st continue'],
		details:
			'After a restack hits a conflict, resolve the conflicts, stage the files, then run `st continue` to resume rebasing the remaining branches.',
	},
	abort: {
		description: 'Abort an in-progress restack',
		flags: [],
		examples: ['st abort'],
		details:
			'Aborts a restack that is paused due to conflicts. The current rebase is aborted and branches after the conflict point remain in their pre-restack state.',
	},
	undo: {
		description: 'Restore stack state to before the last mutating command',
		flags: [
			'--list       Show available restore points',
			'--steps N    How many operations to undo (default: 1)',
			'--dry-run    Preview without applying',
		],
		examples: [
			'st undo',
			'st undo --steps 3',
			'st undo --list',
			'st undo --dry-run',
		],
		details:
			'Every mutating command saves a snapshot. Undo restores git branch refs and stack state to a previous snapshot. Does not undo pushed changes on the remote.',
	},
	config: {
		description: 'View or update stack configuration',
		flags: [
			'--describe         Enable AI-generated PR descriptions (uses Claude Code OAuth)',
			'--no-describe      Disable AI-generated PR descriptions',
			'--auto-watch       Auto-heal a stale state.repo + register the repo with the daemon',
			'--no-auto-watch    Disable auto-watch (warn instead of self-heal; the default)',
		],
		examples: ['st config', 'st config --describe', 'st config --no-describe', 'st config --auto-watch'],
		details:
			'Bare `st config` shows current settings (AI descriptions on/off, auto-watch on/off, auth status). --describe enables AI PR descriptions (requires `st login`); --no-describe disables them. --auto-watch (default off) makes status/graph/submit silently fix a stale state.repo slug and register the repo with the daemon instead of warning; --no-auto-watch restores the warn-and-suggest behavior.',
	},
	login: {
		description: 'Authenticate with Claude Code OAuth for AI features',
		examples: ['st login'],
		details:
			'Stores Anthropic OAuth credentials (in the OS keychain) so AI PR descriptions (`st submit --describe`) can run. Run once before enabling descriptions.',
	},
	logout: {
		description: 'Clear stored AI credentials',
		examples: ['st logout'],
		details: 'Removes the OAuth credentials saved by `st login`.',
	},
	daemon: {
		description: 'Manage the background daemon (merge cascades, PR-status cache, webhooks)',
		flags: [
			'<action>     start | stop | status | logs | attach | run | setup | repo',
			'-f,--follow  Follow log output (with `logs`)',
			'--stack,-s   Filter the stream by stack (with `attach`)',
			'--quick      Use a free trycloudflare.com quick tunnel (with `setup`)',
		],
		examples: [
			'st daemon status',
			'st daemon logs -f',
			'st daemon attach --stack my-stack',
			'st daemon setup --quick',
			'st daemon repo doctor --clean',
			'st daemon repo heal',
		],
		details:
			'The daemon auto-starts and orchestrates merge cascades, caches PR status, and receives GitHub webhooks. `setup` configures the webhook tunnel (--quick for a zero-config public URL); `repo {add|remove|list|doctor|heal}` manages which repos it watches and cleans up orphan webhooks. `repo heal` repairs slug drift after a GitHub rename / org transfer — it converges state.repo, the daemon watch list (moving the entry + webhook by rename, never deleting the live hook), and prints the `git remote set-url origin …` fix (use `heal --remote` to rewrite the origin URL too). It is idempotent ("already healthy" on a second run). Run `st daemon -h` for the full subcommand list.',
	},
	completions: {
		description: 'Print shell completion script for tab completions',
		flags: [
			'<shell>      Shell type: zsh or bash (auto-detected if omitted)',
			'--install    Print installation instructions',
		],
		examples: [
			'st completions zsh',
			'st completions bash',
			'st completions --install',
		],
		details:
			'Outputs a shell completion script for the specified shell. Supports zsh and bash. Completions include all commands, noun groups (st stack, st branch), and dynamic stack name completion.',
	},
	init: {
		description: 'Install Claude Code skills for stack management',
		examples: ['st init'],
		details:
			'Copies the `stack` skill (SKILL.md + references/) into the project\'s .claude/skills/ so Claude Code gets stack awareness here. Re-running updates an existing copy.',
	},
	update: {
		description: 'Self-update to the latest version from GitHub',
		examples: ['st update'],
		details: 'Fetches and installs the latest version via bun.',
	},
};

const overview = `st -- Stacked PRs for GitHub

A CLI tool for managing stacked PRs. Branches form an ordered stack where each PR targets the branch below it (or trunk). State is stored under ~/.claude/stacks/, shared across every git worktree of a repo.

CORE CONCEPTS:
- Stack: An ordered list of branches, rooted at trunk (main/master)
- Branch position: 1-based index in the stack. Branch 1 is closest to trunk.
- Trunk: The base branch (main/master) that the stack builds on
- Navigation: \`st <number>\` jumps to branch N, \`st <name>\` switches stacks
- PR targeting: Each PR targets its parent branch (or trunk for branch 1)
- Restacking: After editing a mid-stack branch, downstream branches need rebasing

TYPICAL WORKFLOW:
  st create my-feature          # start a stack
  # ... write code on branch 1 ...
  st submit                     # push + create PRs
  st down                       # move to branch 2
  # ... write more code ...
  st submit                     # push all + update all PRs
  st merge --all                # merge bottom-up when approved
  st sync                       # clean up after merge

COMMAND GROUPS:
  st stack ...    Stack operations (create, delete, status, submit, merge, ...)
  st branch ...   Branch operations (up, down, fold, move, insert, ...)

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

	// Group commands by their group
	const stackCmds = Object.entries(commands).filter(([, d]) => d.group === 'stack');
	const branchCmds = Object.entries(commands).filter(([, d]) => d.group === 'branch');
	const topLevel = Object.entries(commands).filter(([, d]) => !d.group);

	process.stdout.write('\n  Stack commands (st stack ...):\n');
	for (const [name, doc] of stackCmds) {
		process.stdout.write(`    st stack ${name.padEnd(12)} ${doc.description}\n`);
	}

	process.stdout.write('\n  Branch commands (st branch ...):\n');
	for (const [name, doc] of branchCmds) {
		process.stdout.write(`    st branch ${name.padEnd(12)} ${doc.description}\n`);
	}

	if (topLevel.length > 0) {
		process.stdout.write('\n  Other commands:\n');
		for (const [name, doc] of topLevel) {
			process.stdout.write(`    st ${name.padEnd(18)} ${doc.description}\n`);
		}
	}

	process.stdout.write('\nTIP: Run `st <command> --ai` for detailed docs on any command.\n');
	process.stdout.write('TIP: Run `st stack -h` or `st branch -h` for group help.\n');
}

function printCommandDoc(name: string, doc: CommandDoc): void {
	const prefix = doc.group ? `st ${doc.group} ${name}` : `st ${name}`;
	process.stdout.write(`${prefix} -- ${doc.description}\n`);

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
