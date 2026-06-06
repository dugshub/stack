---
name: stack
description: Manage PR stacks with the `st` CLI — create, submit, restack, sync, merge, split, absorb, navigate, recover, and load stack context for the current branch. Use whenever the user mentions stacks, stacked PRs, restack, st submit, merge a stack, split/absorb changes, branch dependencies, or when you start work on a branch that may belong to a stack.
argument-hint: [status|create|submit|sync|merge|restack|modify|absorb|split|base|nav|undo|continue|<command> --ai]
allowed-tools: Bash, Read
---

# Stack — PR Stack Management

`st` manages stacked PRs on top of `git` + `gh`. This skill is the entry point: it tells you how to **orient**, where the **authoritative command docs** live, and the few **rules that aren't obvious from `--help`**. Depth lives in `references/` — load it on demand.

Do not reason from memory of other stacking tools (Graphite, `gt`, etc.). Command names and flags differ. The source of truth is `st --ai`, described below.

## 1. Orient first

Before acting on a branch, find out whether it's in a stack and where:

```bash
st status --json
```

- **On a stack branch** → a single object with `position` (0-based index of the current branch), `total`, `trunk`, and a `branches[]` array. Report it concisely:
  `Stack: <stackName> | branch <position+1> of <total> | <branch name>` and PR/CI state from each branch's `prStatus`.
- **Not on a stack branch** → an array of all tracked stacks (or empty). Stay quiet unless the user asked about stacks.
- **`restackState` is non-null** (or `restackInProgress: true`) → a restack is paused. Warn: resolve conflicts and run `st continue`.
- **`repoWatch.drifted` or `repoWatch.watched === false`** → see §4a (repo-watch drift) before acting; PR ops may be riding a stale slug.

Full field-by-field schema: references/json.md

## 2. The mental model

- A **stack** is an ordered list of branches rooted at **trunk** (`main`/`master`).
- **Branch 1** is closest to trunk; each branch's PR targets the branch **below** it (branch 1 targets trunk).
- `st` records each branch's **parent tip** so it can rebase precisely — this is why you must not hand-rebase or hand-retarget (see rules).
- State lives in `~/.claude/stacks/` keyed by the repo's shared git object store, so **all worktrees of a repo see the same stacks**.
- Stacks can be **dependent** (built on another stack's branch) or **diamond** (a branch joining two parents via a merge commit).

## 3. Find the exact command (authoritative)

The CLI documents itself. Prefer this over guessing flags:

```bash
st --ai              # concept model + full command index
st <command> --ai    # flags, examples, and behavior for one command (e.g. st submit --ai)
st -h                # short help;  st stack -h / st branch -h for group lists
```

Commands use noun groups with flat aliases: `st stack submit` == `st submit`, `st branch up` == `st up`. `st <number>` jumps to branch N; `st <stack-name>` switches stacks.

If a flag or command isn't in `st <command> --ai`, check `references/workflows.md` (dependent/diamond creation and other flows the index summarizes briefly).

## 4. Rules that aren't obvious from `--help`

1. **`st submit` after every mutation.** `restack`, `modify`, `absorb`, `reorder`, `move`, and merge-cascades all rewrite branch SHAs. Push them or PRs go stale.
2. **Never `git rebase` a stack branch by hand.** Use `st restack` (cascade after a mid-stack edit) or `st modify` (amend + cascade in one step). Manual rebases break parent-tip tracking.
3. **Never manually change a PR's base branch.** `st submit` owns PR targeting and will overwrite manual retargets.
4. **After merges, run `st sync`** — it removes merged branches, rebases the rest, and converts a dependent stack to standalone when its base merges. Don't hand-delete branches or close PRs.
5. **On a rebase conflict:** resolve files, `git add` them, then `st continue` (or `st abort` to back out). Use `st undo` to roll back a bad operation (snapshots are saved before every mutating command).
6. **`st check <cmd>` before submitting** runs a command on every branch (e.g. `st check --bail bun test`) — catches breakage the diff of one branch hides.

### 4a. Repo-watch drift (after a GitHub rename / org transfer)

A repo rename or transfer keeps "working" through GitHub's redirect while three stores silently rot: `state.repo` (PR ops ride the redirect and break the day the old name is reclaimed), the daemon's watch list + webhook (merge cascades and the PR-status cache quietly stop), and nothing surfaces it. `st` now detects and repairs this:

- **`st status` / `st graph`** warn when `state.repo` differs from the origin remote slug, or when the repo isn't watched by the daemon. In the interactive graph (`st -i` / `st graph`), a banner appears and **`w`** repairs it in place.
- **`st daemon repo heal`** is the one-command fix: it converges `state.repo`, the daemon watch list + webhook (moved by **rename — the live hook is never deleted**), and prints the `git remote set-url origin …` command (add `--remote` to rewrite the origin URL too). Idempotent — "already healthy" on a re-run.
- **`st config --auto-watch`** (off by default) makes status/graph/submit self-heal the cheap repairs inline (fix `state.repo`, register with the daemon) instead of warning.

## 5. Going deeper (progressive disclosure)

- **Workflows** — create / dependent / diamond, submit & describe, modify, sync, merge, absorb, split, base re-parent, comment preview, navigation, check: references/workflows.md
- **Recovery** — conflicts, `continue`/`abort`, `undo`, post-merge cleanup, trunk moved, diamond conflict phases, daemon issues: references/recovery.md
- **`status --json` schema** — exact fields for both output shapes: references/json.md

## 6. Execution (when invoked as `/stack`)

Run the CLI directly, passing through arguments:

```bash
st $ARGUMENTS
```

If `$ARGUMENTS` is empty, run `st status`. In this repo's dev checkout, `st` may be `bun run src/cli.ts`. If `st` isn't installed, tell the user:

```bash
bun install -g git+https://github.com/dugshub/stack.git
```
