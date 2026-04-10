# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A CLI tool (`st`) for managing stacked PRs — a Graphite replacement powered by `git`, `gh`, and good defaults. State is stored in `~/.claude/stacks/<repo>.json`.

## Development

This is a Bun + TypeScript project. The binary runs directly via `bun` (no build step needed for dev).

```bash
bun install                    # install deps
bun run src/cli.ts <command>   # run locally
st submit --dry-run            # verify plan before submitting
```

No test suite exists yet. Verify changes with `st submit --dry-run`.

## Architecture

**Entry point:** `src/cli.ts` — registers all commands with [clipanion](https://github.com/arcanis/clipanion).

**Commands** (`src/commands/`): One file per command. Commands use noun-group paths with flat aliases: e.g., `static override paths = [['stack', 'submit'], ['submit']]`. Stack-level commands live under `st stack`, branch-level under `st branch`, with convenience aliases at the top level. To add a command: create the file, export a class extending `Command`, register it in `cli.ts`.

**Lib modules** (`src/lib/`):
- `git.ts` — Git operations via `Bun.spawnSync`. Provides `run()` (throws on failure) and `tryRun()` (returns result object).
- `gh.ts` — GitHub CLI wrapper via `Bun.spawnSync`. Wraps `gh pr create/edit/comment/view/list`.
- `state.ts` — Load/save stack state from `~/.claude/stacks/<repo>.json`. Atomic writes via tmp file + rename.
- `types.ts` — Core types: `StackFile`, `Stack`, `Branch`, `PrStatus`, `StackPosition`.
- `branch.ts` — Branch name parsing and PR title derivation.
- `comment.ts` — Stack navigation comment generation for PRs.
- `ui.ts` — Terminal output helpers.

## Versioning & Changelog

- **Patch bump** (0.7.0 → 0.7.1) for most changes worth mentioning — features, fixes, improvements.
- **Minor bump** (0.7.x → 0.8.0) reserved for themed milestone batches.
- Bug-only fixes can skip a version bump.
- When bumping, update both `package.json` version and `CHANGELOG.md`. The changelog is shown to users on `st update`.

## Key Design Decisions

- All git/gh operations use `Bun.spawnSync` (synchronous) — no async anywhere.
- State is a flat JSON file keyed by repo name, not per-branch metadata in git config.
- PR titles derived from branch names: `user/stack-name/1-add-schema` → "Add Schema". Falls back to last commit subject.
- Submit pushes with `--force-with-lease` and posts stack navigation comments on each PR.
- The squash-merge sync problem is an active research area (see `RESEARCH.md`).
