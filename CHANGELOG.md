# Changelog

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
