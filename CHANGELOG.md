# Changelog

## 0.9.11

<<<<<<< HEAD
- Docs & skills overhaul. The two shipped skills are consolidated into one lean, agent-facing `stack` skill that defers to the CLI's own engine (`st --ai`, `st status --json`) for anything that can drift, with `references/{workflows,recovery,json}.md` for depth. The redundant `stack-management` auto-loader is retired (its job — report stack position — is folded in). `st init` now copies the whole skill directory (so the reference files ship) and removes a stale `stack-management` copy on re-run.
- `st --ai` is now accurate: `create` documents `--base`/`--also-base`/`--yes` (dependent + diamond stacks), `submit` documents `--ready`/`--describe`/`--update`, `merge` matches its real flags (`--all`/`--now`/`--dry-run`), and `comment`/`config`/`login`/`logout`/`daemon` are documented (previously missing).
- `CLAUDE.md` and `README.md` updated for the daemon/server subsystem, AI PR descriptions, diamond stacks, `st base`, `st comment`, `st daemon repo`, `st daemon setup --quick`, the test suite, and worktree-shared state.
=======
- `st sync` now rebases your stack onto the freshly-fetched remote trunk (`origin/<trunk>`) instead of a stale local trunk branch. Fixes two cases where the stack was left on the wrong base: (1) a local trunk diverged from the remote — sync used to rebase onto the stale local branch and silently report success; (2) running from a linked worktree where the trunk is checked out elsewhere — sync used to abort after deleting the merged branch, leaving a half-synced stack. The local trunk branch is still fast-forwarded as a non-fatal convenience.
>>>>>>> 54b0735 (fix: st sync rebases stack onto remote trunk, not stale local branch (0.9.11))

## 0.9.10

- Fixed `st continue` crashing with an "Internal Error" (`git checkout ""` — empty pathspec) after resolving a conflict. The rebase itself completed correctly, but the final step that returns you to your branch ran while HEAD was still detached mid-rebase, so it had no branch name to check out. `st continue` now falls back to the branch you just resolved and never lets a failed checkout poison the exit code. Affected every conflict-resume (`st sync` and `st restack`); most visible since 0.9.8 made `st sync` rebase on trunk movement.

## 0.9.9

- Stack state is now shared across all git worktrees of a repo. State is keyed by the shared object store (`git rev-parse --git-common-dir`) instead of the working-tree path, so running `st` from a worktree sees the same stacks as the main checkout — work the same stack from several worktrees simultaneously. Previously each worktree silently got its own divorced state file named after the worktree directory.
- Existing orphan state files left by the old keying are migrated automatically on first run inside a worktree: their stacks are folded into the repo's canonical file (canonical copies win on name collision) and the orphan is archived (`<name>.json.migrated-<timestamp>`). Guarded by repo identity, so an unrelated repo whose name happens to match a worktree directory is never touched.
- Separate *clones* of a repo stay isolated (their commits don't share an object store), which is intentional — see `RESEARCH.md` for the logical-vs-physical state model and the deferred account/remote sharing tier.
- Daemon hardening: when multiple state files carry the same repo slug, the daemon now prefers the one with real stacks so a leftover empty file can't shadow live data.

## 0.9.8

- `st sync` now rebases your stack when the trunk advanced on the remote, not only when a PR merged — no more manual `git pull` + `st restack`.

## 0.9.7

- `st` now nudges users to run `st init` at the end of every invocation when the bundled `stack` skill isn't installed in the project's `.claude/skills/`. Keeps the shipped Claude Code skill discoverable instead of relying on users finding `st init` on their own. Skipped for meta commands (`init`, `update`, `login`/`logout`, `completions`, help/version, `--ai`) where the message would be noise.

## 0.9.6

- Quick-tunnel mode (`st daemon setup --quick`) — zero-config public URL via trycloudflare.com; webhook URL re-synced on each daemon start.

## 0.9.5

- Diamond stacks work end-to-end: create, restack, continue/abort on conflict, submit, merge — same daily loop as a linear stack
- `st create --base <B> --also-base <C>` records per-parent tips and the merge SHA so the join branch can be re-rebased without walking history
- `st restack` re-creates the merge commit when a parent tip moves (reset to primary → re-merge secondaries → replay commits on top) and cascades through downstream branches
- `st continue` distinguishes the `merging` phase from the `replaying` phase of a diamond conflict and finalises state correctly
- `st abort` unwinds an in-progress merge or cherry-pick and resets the join branch to its pre-restack tip
- `st modify` cascades through diamond dependents — amending a commit in an upstream stack automatically re-rolls a diamond's merge
- `st submit` opens the PR against the primary parent (no more "phase 1 limitation" warning)
- `st graph` lists every parent for a diamond in the trunk header (`(→ feat#2 + feat-alt#1)`)
- `Stack.dependsOn` is always serialised as an array; read-time migration from the legacy object shape is preserved

## 0.9.4

- `st daemon repo` — manage which repos the daemon watches and clean up orphan webhooks. `add <owner/repo>`, `remove <owner/repo>`, `list`, and `doctor [--clean]`. Doctor surfaces hooks the daemon recognizes as its own but isn't tracking; `--clean` deletes them via the GitHub API. Closes the gap surfaced by the orphan-detection log line in 0.9.3

## 0.9.3

- Fix: daemon now reconciles webhooks against GitHub instead of trusting the local config blindly. On startup (and when registering a repo), if no hook ID is cached the daemon lists `/repos/{repo}/hooks` and adopts any hook matching its signature (URL path `/webhooks/github`, JSON content type, exact event set). Multiple matches are logged as orphans for opt-in cleanup. This stops orphan hooks accumulating after `server.config.json` wipes or laptop swaps

## 0.9.2

- Fix: webhook URL drift is now propagated to GitHub. Previously, when an existing webhook was found, the daemon PATCHed only the events array — never `config.url` — so changes to `publicUrl` or `tunnel.hostname` between runs left GitHub delivering to a dead URL. The PATCH now includes the full config (url, content_type, secret), and drift is logged when detected

## 0.9.1

- `st stack base <new-base>` (flat alias `st base`) re-parents an existing stack onto a different base branch — move from `main` to `develop`, turn a standalone stack into a dependent one, or swap which stack a dependent builds on. Updates the first PR's base on GitHub before the local rebase so conflicts don't leave PRs pointing at the old base; cascades to downstream dependent stacks.

## 0.9.0

- Daemon now cascades to **dependent stacks** on PR merge. When a PR merges, any stack whose `dependsOn` references the merged branch is automatically rebased onto the parent's trunk, pushed, and retargeted — no more manual `st sync` on downstream stacks
- `st daemon attach` no longer drops out on idle — SSE log stream emits a keepalive every 30s to survive the server's idle timeout
- Stack navigation comments no longer include branches or stacks that have no PR — nothing to link to, so they're dropped from the rendered tree

## 0.8.1

- `st comment` command to preview stack navigation comment markdown without posting to GitHub
- Multi-stack PR comment rendering — comments now show upstream and downstream stacks in the chain, not just the current stack's branches

## 0.8.0

- `st restack` from top of stack (or single-branch stacks) now cascades to dependent stacks instead of exiting with "nothing to restack"
- Daemon merge cascade updates state file before pushing, fixing race where `stack/rebase-status` check got stuck on `pending`

## 0.7.0

- PR attribution now says "Managed by stack CLI" linking to dugshub/stack (replaces Claude Code branding)
- `st submit --ready` staggers `gh pr ready` calls by 2s so Slack notifications arrive in stack order
- Custom help renderer with alias support (`st submit -h` and `st stack submit -h` show the same output)
- Structured daemon log formatting: categories (`←` webhook, `$` git, `→` api), color, indentation for cascade ops
- Daemon no longer auto-merges after restacking — merging is always the user's decision

## 0.6.6

- Stack checks (`stack/merge-ready`, `stack/rebase-status`) now show as pending (yellow) instead of failure (red) — stops scaring reviewers
- OAuth login no longer requires `org:create_api_key` — uses access token directly
- `st update` automatically restarts the daemon so it picks up new code

## 0.6.5

- Interactive graph dashboard as default home screen (`st` / `st -i`)
- Smart absorb routing with interactive prompts and `--route` flag
- Expanded graph view as default for `st` dashboard

## 0.6.4

- Contextual tab completion for command arguments, branch and stack names
- Auto-stash dirty worktree during merge operations
- Cascading restack for dependent stacks

## 0.6.3

- Daemon redesign: slim webhook receiver instead of merge orchestrator
- OAuth login with macOS Keychain storage, replacing API key prompts
- AI description writer upgraded to Sonnet 4.6
- Parallel AI description generation with `Promise.allSettled`
