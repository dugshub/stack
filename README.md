# st

Stacked PRs for GitHub. No accounts, no hosted service -- just `git` and `gh`.

`st` manages stacks of dependent pull requests so reviewers see clean, incremental diffs and you can keep shipping while waiting for review. It handles the rebasing, retargeting, and comment-updating that makes stacking painful by hand.

<!-- TODO: GIF - full workflow: create stack, make commits, submit, show PRs created on GitHub. ~15 seconds, tight edit. -->

---

## Why st?

- **No service dependency.** Graphite requires a hosted backend and account. `st` is local-first -- state lives in a JSON file, operations use `git` and `gh` directly.
- **Works with squash-merge.** Built to handle GitHub's squash-merge workflow without spurious conflicts.
- **AI-powered PR descriptions.** Generate contextual descriptions with Claude via OAuth -- no API keys to manage.
- **Claude Code integration.** Install stack-aware skills so Claude can navigate, submit, and restack as part of larger workflows.
- **Single binary, zero config.** Install and go. No init, no server, no `.graphiterc`.

## Install

```bash
bun install -g git+https://github.com/dugshub/stack.git
```

Requires [Bun](https://bun.sh) and the [GitHub CLI](https://cli.github.com) (`gh auth login`).

Then set up tab completions:

```bash
st completions --install
```

## Quick Start

```bash
# Create a stack
st create my-feature -d add-schema   # -d names the first branch

# Work on the first branch, commit normally
# ... edit files, git add, git commit ...

# Add the next branch to the stack
st track                          # adds current branch if you branched manually
# -- or --
st insert --after 1               # insert a new branch after position 1

# Push everything and create PRs
st submit

# Someone reviews branch 1. Meanwhile, keep working on branch 2.
# Need to fix something in branch 1?
st down                           # move to branch 1
st modify -a                      # amend + auto-restack downstream

# Ready to merge
st merge --all                    # enables auto-merge, cascades through the stack
```

That's it. Each PR targets the branch below it, reviewers see only the diff for that layer, and `st` posts a navigation comment on every PR showing where it sits in the stack.

## Features

### Stack Graph Dashboard

Run `st` with no arguments to see an expanded graph of all your stacks, with PR status, review state, and CI checks at a glance. Run `st -i` for the interactive version with keyboard navigation.

<!-- TODO: GIF - run `st` showing graph dashboard with multiple stacks, PR status badges, and CI indicators. Then switch to `st -i` and arrow through branches. -->

### Submit and PR Management

`st submit` pushes all branches and creates or updates draft PRs in a single command. It uses batched GraphQL mutations -- one API call to create PRs, one to update bases and comments. Force-push uses `--force-with-lease` for safety.

```bash
st submit                  # push + create/update PRs
st submit --dry-run        # preview the plan
st submit --ready          # mark all drafts as ready for review
st submit --describe       # generate AI PR descriptions
st submit --update         # regenerate descriptions for existing PRs
```

### AI PR Descriptions

Log in with your Anthropic account and `st` generates contextual PR descriptions using Claude. Descriptions are generated in parallel across all branches.

```bash
st login                           # OAuth login (stored in macOS Keychain)
st config --describe               # enable by default
st submit --describe               # or per-submit
```

### Restack

After editing a mid-stack branch, `st restack` cascades the rebase through all downstream branches. If there are conflicts, resolve them and `st continue`. Cascading extends to dependent stacks automatically.

<!-- TODO: GIF - edit a file on branch 2 of a 4-branch stack, run `st modify -a`, watch restack cascade through branches 3 and 4. -->

```bash
st modify -a               # amend current branch + restack in one step
st restack                 # manual restack from current position
st continue                # after resolving conflicts
st abort                   # bail out
```

### Sync

After PRs merge on GitHub, `st sync` cleans up: removes merged branches, retargets remaining PRs, rebases onto trunk. Handles squash-merge correctly by using `rebase --onto` with the pre-merge branch tip.

```bash
st sync                    # fetch, remove merged, rebase remaining
```

### Merge

Merge an entire stack through GitHub's auto-merge. The daemon watches each PR merge, then rebases, retargets, and enables auto-merge on the next one.

<!-- TODO: GIF - run `st merge --all` on a 3-PR stack, show the cascade as each PR merges and the next one gets enabled. Speed up the waiting parts. -->

```bash
st merge                   # enable auto-merge on current PR
st merge --all             # cascade through the entire stack
st merge --dry-run         # show the merge plan
st merge --now             # merge immediately (bottom PR only)
```

### Absorb

Working tree has changes that belong on different branches? `st absorb` routes each file to its owning branch based on diff history. Ambiguous files get interactive prompts. Manual routing is available for CI or scripted use.

<!-- TODO: GIF - stage changes touching files from 3 different branches, run `st absorb`, show auto-routing output and one interactive prompt for an ambiguous file. -->

```bash
st absorb                                      # auto-route by ownership
st absorb --dry-run                             # preview
st absorb --branch 3 file.ts                    # manual: send file to branch 3
st absorb --route 4-cache:cache.go --route 5-api:handler.go   # batch routing
```

### Split

Turn a pile of uncommitted changes into a structured stack in one command. Specify branch descriptions and file patterns -- `st split` creates branches, commits files, and registers the stack.

```bash
st split "schema:src/db/**" "api:src/api/**" "ui:src/components/**"
st split --dry-run "schema:src/db/**" "api:src/api/**"
```

### Navigation

Move between branches in a stack without remembering branch names.

```bash
st up                      # one branch toward the top
st down                    # one branch toward the bottom
st top                     # jump to the top
st bottom                  # jump to the bottom
st 3                       # jump to branch #3
st nav                     # interactive picker with PR status
st my-feature              # switch to a stack by name
```

### Branch Operations

```bash
st track                   # add current branch to the stack
st insert --after 2        # insert a new branch after position 2
st fold                    # merge current branch into its parent
st move up                 # reorder: move branch toward trunk
st move 3                  # reorder: move branch to position 3
st remove                  # remove branch from stack (keeps git branch)
st pop                     # remove from stack + keep changes
st rename new-desc         # rename current branch
st reorder 3 1 2 4         # reorder all branches
```

### Check

Run a command on every branch in the stack. Useful for verifying type-checks or tests don't break across the stack.

```bash
st check bun tsc --noEmit
st check --bail npm test           # stop on first failure
st check --from 3 make build       # start from branch 3
st check --json bun test           # JSON output for CI
```

### Undo

Every mutating command saves a snapshot. Undo restores both state and git branch tips.

<!-- TODO: GIF - run a restack that goes wrong, then `st undo` to snap back. Show the before/after state with `st`. -->

```bash
st undo                    # undo last operation
st undo --steps 3          # go back 3 operations
st undo --list             # show available restore points
st undo --dry-run          # preview what would change
```

### Daemon and Webhooks

A background daemon receives GitHub webhooks to watch merge cascades and cache PR statuses. It starts automatically and stays out of the way.

```bash
st daemon status           # check if running
st daemon start            # manual start
st daemon attach           # stream logs
st daemon logs -f          # tail log file
```

### Claude Code Integration

Install stack-aware skills into your project so Claude Code can operate on your stacks:

```bash
st init                    # installs skills into .claude/skills/
```

Claude will see stack context and can run `st submit`, `st restack`, `st sync`, etc. as part of larger coding workflows. Use `st --ai` to get LLM-friendly documentation for any command.

## Command Reference

### Stack Commands (`st stack` or `st s`)

| Command | Alias | Description |
|---------|-------|-------------|
| `stack create <name>` | `create` | Create a new stack or adopt existing branches |
| `stack delete <name>` | `delete` | Remove a stack from tracking |
| `stack status` | `status` | Show current stack and PR status |
| `stack submit` | `submit` | Push branches, create/update PRs |
| `stack sync` | `sync` | Clean up after merges |
| `stack merge` | `merge` | Merge stack PRs via auto-merge |
| `stack restack` | `restack` | Rebase downstream after mid-stack edits |
| `stack check` | `check` | Run a command on every branch |
| `stack graph` | `graph` | Show stack dependency graph |

### Branch Commands (`st branch` or `st b`)

| Command | Alias | Description |
|---------|-------|-------------|
| `branch up` | `up` | Move up one branch |
| `branch down` | `down` | Move down one branch |
| `branch top` | `top` | Jump to the top |
| `branch bottom` | `bottom` | Jump to the bottom |
| `branch nav` | `nav` | Interactive branch picker |
| `branch track` | `track` | Add current branch to the stack |
| `branch remove` | `remove` | Remove a branch from the stack |
| `branch pop` | `pop` | Pop branch, keep changes |
| `branch fold` | `fold` | Merge branch into its parent |
| `branch rename` | `rename` | Rename current branch |
| `branch move` | `move` | Move a branch within the stack |
| `branch insert` | `insert` | Insert a new branch at position |
| `branch reorder` | `reorder` | Reorder all branches |
| `branch modify` | `modify` | Amend and restack |
| `branch absorb` | `absorb` | Route fixes to correct branches |
| `branch split` | `split` | Split changes into a stack |

### Other Commands

| Command | Description |
|---------|-------------|
| `st undo` | Undo last operation |
| `st continue` | Continue after resolving conflicts |
| `st abort` | Abort an in-progress restack |
| `st config` | View or update settings |
| `st login` | Anthropic OAuth login |
| `st logout` | Clear stored credentials |
| `st daemon` | Manage background daemon |
| `st completions` | Install shell completions (zsh, bash) |
| `st init` | Install Claude Code skills |
| `st update` | Self-update to latest version |
| `st --ai [cmd]` | LLM-friendly docs for any command |

## Day-to-Day Workflow

**Starting a stack.** `st create my-feature -d first-change` creates a stack and checks out the first branch. Work normally -- commit, push, whatever. When you're ready for the next layer, create a new branch from the current one and `st track` it, or use `st insert` to add a branch at a specific position.

**Editing mid-stack.** Check out the branch you need to fix (`st 2` or `st down`). Make your changes, then `st modify -a` to amend and auto-restack everything downstream. Or use `st absorb` to route scattered fixes to the right branches automatically.

**Submitting for review.** `st submit` pushes all branches and creates draft PRs. Add `--ready` to mark them for review. Add `--describe` to generate AI descriptions.

**After review.** When the bottom PR merges, `st sync` removes it and rebases the rest. Or use `st merge --all` to cascade auto-merge through the entire stack -- walk away and come back to a clean trunk.

**Conflicts during restack.** Resolve the conflicting files, `git add` them, then `st continue`. If you want to bail, `st abort`.

**Oops.** `st undo`. Every mutating command is reversible.

## Branch Naming

`st` uses this convention to derive PR titles automatically:

```
<user>/<stack-name>/<n>-<description>
```

For example:

```
dug/my-feature/1-add-schema      -> PR title: "Add Schema"
dug/my-feature/2-api-endpoints   -> PR title: "Api Endpoints"
dug/my-feature/3-update-tests    -> PR title: "Update Tests"
```

When you use `st create` or `st insert`, branch names follow this pattern automatically. If you name branches differently, `st` falls back to the last commit subject as the PR title.

## How It Works

State is stored in `~/.claude/stacks/<repo>.json` -- a flat JSON file keyed by repo, not per-branch metadata in git config. All git and GitHub operations use synchronous calls (`Bun.spawnSync`). PR mutations are batched into single GraphQL requests. Force-pushes use `--force-with-lease`.

The squash-merge problem (GitHub replaces your commits with a single squash commit, breaking naive rebase) is handled by tracking branch tips and using `rebase --onto` with the pre-merge tip as the exclusion point.

## Updating

```bash
st update
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) -- free to use, modify, and share. Not for commercial use.
