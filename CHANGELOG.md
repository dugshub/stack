# Changelog

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
