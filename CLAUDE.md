# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A CLI tool (`st`) for managing stacked PRs — a Graphite replacement powered by `git`, `gh`, and good defaults. A background daemon orchestrates merge cascades and caches PR status via GitHub webhooks; optional AI PR descriptions run through Anthropic OAuth. State is stored under `~/.claude/stacks/`, keyed by the repo's shared git object store so all worktrees share it.

## Development

This is a Bun + TypeScript project. The binary runs directly via `bun` (no build step needed for dev).

```bash
bun install                    # install deps
bun run src/cli.ts <command>   # run locally
st submit --dry-run            # verify plan before submitting
```

```bash
bun test                       # run the test suite
```

Tests are colocated (`*.test.ts`, e.g. `src/commands/absorb.test.ts`, `src/server/webhook-manager.test.ts`). Coverage is partial — also verify command changes with `st submit --dry-run` and `st <command> --ai`.

## Architecture

**Entry point:** `src/cli.ts` — registers all commands with [clipanion](https://github.com/arcanis/clipanion).

**Commands** (`src/commands/`): One file per command. Commands use noun-group paths with flat aliases: e.g., `static override paths = [['stack', 'submit'], ['submit']]`. Stack-level commands live under `st stack`, branch-level under `st branch`, with convenience aliases at the top level. To add a command: create the file, export a class extending `Command`, register it in `cli.ts`.

**Lib modules** (`src/lib/`):
- `git.ts` — Git operations via `Bun.spawnSync`. Provides `run()` (throws on failure) and `tryRun()` (returns result object).
- `gh.ts` / `graphql.ts` — GitHub CLI wrapper and batched GraphQL queries/mutations for PR data.
- `state.ts` — Load/save stack state under `~/.claude/stacks/`, keyed by `git rev-parse --git-common-dir` (shared across worktrees). Atomic writes via tmp file + rename; `migrateWorktreeState()` folds in pre-0.9.9 orphan files.
- `types.ts` — Core types: `StackFile`, `Stack`, `Branch`, `PrStatus`, `StackPosition`, `RestackState`, `StackParent`.
- `branch.ts` — Branch name parsing and PR title derivation.
- `comment.ts` — Stack navigation comment generation for PRs.
- `resolve.ts` / `base-resolver.ts` — Resolve the active stack and base-branch references.
- `rebase.ts` / `undo.ts` — Restack/cascade engine and snapshot-based undo.
- `pr-status.ts` / `dashboard.ts` / `interactive-graph.ts` — PR status rendering, the bare-`st` dashboard, and the `st -i` TUI.
- `ai-docs.ts` — Source of `st --ai` docs (hand-maintained per-command map). Keep in sync with command flags.
- `ai/` — Anthropic OAuth + AI PR-description generation.
- `ui.ts` / `theme.ts` / `format.ts` / `hints.ts` / `help.ts` — Terminal output, theming, and the custom help renderer.

**Server / daemon** (`src/server/`): a background HTTP server (`lifecycle.ts` auto-starts it; `index.ts` serves) that receives GitHub webhooks (`webhook.ts`, `webhook-manager.ts`), drives merge cascades and dependent-stack rebases, caches PR status (`cache.ts`), and can expose a public URL via Cloudflare tunnel (`tunnel.ts`, incl. `--quick` trycloudflare mode). User-facing entry points are `st daemon` (`daemon.ts`) and `st daemon repo` (`daemon-repo.ts`).

## Versioning & Changelog

- **Patch bump** (0.7.0 → 0.7.1) for most changes worth mentioning — features, fixes, improvements.
- **Minor bump** (0.7.x → 0.8.0) reserved for themed milestone batches.
- Bug-only fixes can skip a version bump.
- When bumping, update both `package.json` version and `CHANGELOG.md`. The changelog is shown to users on `st update`.

## Shipped Skills

The `.claude/skills/stack/` skill is a **shipped artifact** — `st init` copies the whole directory (`SKILL.md` + `references/`) into the consumer project's `.claude/skills/` (see `src/commands/init.ts`). Treat it like public API docs. It is the single stack skill; the old `stack-management` auto-loader was folded in (`st init` removes a stale copy on re-run).

The skill is deliberately thin and uses **progressive disclosure**: `SKILL.md` defers exact flags to the CLI's own engine (`st --ai <command>`, `st status --json`) and links `references/{workflows,recovery,json}.md` for depth. This means the primary "command reference" lives in `src/lib/ai-docs.ts`, not the skill.

**Rule:** any change to a command's user-facing surface — new command, renamed/removed command or alias, new/renamed/removed flag, changed default, changed output shape — must update the source of truth in the same PR:

- Flags / commands / behavior → update `src/lib/ai-docs.ts` (powers `st --ai`). Add hand-written workflow guidance to `.claude/skills/stack/references/workflows.md` only for flows `--ai` summarizes poorly (e.g. dependent/diamond create).
- `st status --json` shape → update `.claude/skills/stack/references/json.md` (field-by-field schema).
- New top-level concepts/rules → update `.claude/skills/stack/SKILL.md`.

The CLI nudges users at the end of every invocation when the skill isn't installed in their project, so out-of-date skills are highly visible.

## Key Design Decisions

- Git/gh operations use `Bun.spawnSync` (synchronous); commands read top-to-bottom with no async ceremony. The daemon/webhook server (`src/server/`) and GraphQL batching are the deliberate async exceptions.
- State is a flat JSON file keyed by the repo's shared git object store (so worktrees share it), not per-branch metadata in git config.
- PR titles derived from branch names: `user/stack-name/1-add-schema` → "Add Schema". Falls back to last commit subject.
- Submit pushes with `--force-with-lease` and posts stack navigation comments on each PR.
- The squash-merge sync problem is an active research area (see `RESEARCH.md`).
