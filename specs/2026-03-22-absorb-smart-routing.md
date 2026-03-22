# Smart Absorb Routing

**Status:** Draft
**Date:** 2026-03-22

## Problem

`st absorb` currently gives up on two categories of files:
1. **Ambiguous** — file touched by 2+ stack branches (conflicted ownership)
2. **Unowned** — file not touched by any stack branch (new files, or files only in trunk)

Today the user must manually re-run with `--branch N file1 file2` for each group. This is friction-heavy, especially for AI agents that need to parse the warning output and construct follow-up commands.

## Scenarios to Handle

### Scenario 1: Ambiguous file (2+ branch owners)
**Example:** `goldmark.go` is in the diff for both branch 4 and branch 6.
- **Human:** prompt "Which branch should own this file?" with a select menu
- **AI:** output a structured hint with the candidate branches and a ready-to-run command

### Scenario 2: Unowned file (new or trunk-only)
**Example:** `registry.go` isn't in any branch's diff.
- **Human:** prompt "Which branch should this go to?" with all branches listed
- **AI:** list all branches with concrete commands for each

### Scenario 3: Mixed batch
**Example:** 3 files dirty — 1 auto-routes, 1 ambiguous, 1 unowned.
- Auto-route the clean one, then prompt/hint for the remaining two.
- After prompts are answered, execute everything in a single pass (not N separate absorb runs).

### Scenario 4: All files ambiguous/unowned (nothing auto-routes)
- Don't bail with "No files can be absorbed" — go straight to prompts/hints.

### Scenario 5: Non-interactive (piped stdin or `--no-prompt`)
- Skip prompts, show hints only. AI agents and scripts use this path.

## Design

### Interactive Mode (default when `process.stdin.isTTY`)

After building the ownership map, instead of printing warnings and stopping:

```
Absorb plan

✓ branch-4 (1 file)
  goldmark.go

? goldmark.go is touched by branch-4 and branch-6
  ❯ branch-4 (dugshub/cli-components/4-goldmark-renderer)
    branch-6 (dugshub/cli-components/6-table-rendering)
    [skip]

? registry.go is not owned by any branch
  ❯ branch-1 (dugshub/cli-components/1-...)
    branch-2 (dugshub/cli-components/2-...)
    ...
    [skip]
```

Each prompt uses `@clack/prompts` `select()`. Files assigned via prompts are merged into the absorbable map, then the entire batch executes in one pass.

- If the user selects `[skip]`, the file stays in the working tree (current behavior).
- If the user presses Ctrl-C (`p.isCancel()`), exit cleanly with code 130 — no changes made.

**`--dry-run` + prompts:** Prompts still fire so the user can see the resolved plan, but execution is skipped. The plan output reflects the user's selections annotated as `(interactive)`.

### Non-Interactive Mode (piped stdin or `--no-prompt`)

Print a **hints block** after the plan with concrete, copy-pasteable commands:

```
Absorb plan

⚠ goldmark.go (touched by branch-4, branch-6)
  registry.go (not owned by any stack branch)

No files can be absorbed automatically.

hint: Route ambiguous files:
  st absorb --route 4-goldmark-renderer:goldmark.go

hint: Assign registry.go to a branch:
  st absorb --route 1-first-branch:registry.go
  st absorb --route 2-second-branch:registry.go
  st absorb --route 3-third-branch:registry.go
  ...

hint: Or combine routing in one command (human convenience — AI agents should use the concrete per-file commands above):
  st absorb --route 4-goldmark-renderer:goldmark.go --route <BRANCH>:registry.go
```

For ambiguous files, the hint picks the first candidate branch (the user can choose differently). For unowned files, all branches are enumerated as concrete commands — no unparseable `<N>` placeholders except in the combined example where the user must choose.

### New `--route` Flag (Batch Routing)

Allow multiple `--route <branch>:<file>` arguments in a single invocation:

```bash
st absorb --route 4-goldmark-renderer:goldmark.go --route 7-multiline-input:registry.go
```

Parsing rules:
- Split on the **first** colon only (file paths may contain colons on some systems)
- The branch identifier tries integer parse first (1-based index), then falls back to substring match against branch names
- **Multiple substring matches:** if the identifier matches more than one branch name, error with "ambiguous branch identifier '...' matches: branch-a, branch-b"
- Each file is validated against the dirty set (same as `--branch` behavior — warn and skip non-dirty files)
- `--route` entries are added to `manualFiles` set, same as `--branch` entries, ensuring they are excluded from automatic classification and interactive prompts

**Composition with `--branch`:** `--route` and `--branch` compose into the same `manualRoute` map. If `--branch N` is given with no positional files but `--route` flags are present, `--branch` is silently ignored (no error, no warning) — only error if `--branch` is the sole routing mechanism and has no files. The `--branch` flag does NOT implicitly apply to unrouted files; it only operates on its positional arguments.

## Implementation Plan

### Step 1: Add `--route` flag (batch routing)
- Accept `--route` as `Option.Array` (multiple values)
- Parse `<identifier>:<filePath>`, splitting on first `:`
- Resolve identifier: try `parseInt` for 1-based index, fallback to name match via `stack.branches.findIndex(b => b.name.includes(identifier))`
- Error on multiple substring matches (list the matching branches)
- Validate files against dirty set (warn + skip non-dirty)
- Add routed files to `manualFiles` set (shared with `--branch`)
- Merge into `manualRoute` map
- Adjust `--branch` validation: only error on missing positional files if no `--route` flags are present

### Step 2: Add interactive prompts for ambiguous/unowned files
- Detect TTY via `process.stdin.isTTY` (not `process.stderr.isTTY` — stdin is what matters for reading input)
- Add `--no-prompt` flag: `Option.Boolean('--no-prompt', false)`
- **Code restructure required:** the `absorbable.size === 0` early exit (currently line 228) must move to AFTER prompt resolution. New flow:
  1. Classify files (existing logic)
  2. If interactive and there are ambiguous/unowned files → prompt
  3. Merge prompt selections into absorbable map
  4. NOW check `absorbable.size === 0` — if still empty after prompts, exit
  5. If `--dry-run`, show resolved plan and exit
  6. Execute
- Follow the `create.ts` pattern for `@clack/prompts` usage (already uses `await p.confirm()` inside `async execute()`)
- For each ambiguous file: `p.select()` with candidate branches + `[skip]`
- For each unowned file: `p.select()` with all branches + `[skip]`
- Handle `p.isCancel()` on every prompt — exit with code 130, no changes made
- Files already in `manualFiles` (from `--route` or `--branch`) are excluded from prompts
- **`saveSnapshot` placement:** `saveSnapshot('absorb')` must remain AFTER the dry-run check and BEFORE the execute block. Do not move it before prompts — cancelled prompts should not create undo snapshots.

### Step 3: Add hint output for non-interactive mode
- When not interactive (`!process.stdin.isTTY || this.noPrompt`) and there are unresolved files:
  - For ambiguous files: print concrete `st absorb --route <first-candidate>:<file>` command
  - For unowned files: enumerate ALL branches as concrete commands (no placeholders)
  - Show a combined `--route` example at the end for convenience
- Hints appear after the plan, before the "No files can be absorbed" message

### Step 4: Add `--json` flag (deferred — separate follow-up)
Deferred to keep this change focused. The hint output in Step 3 provides sufficient machine-parseable guidance for AI agents. `--json` can be added independently later without affecting Steps 1–3.

## Files to Modify

- `src/commands/absorb.ts` — all changes live here (prompts, `--route` parsing, hint output)
- No new files needed
- `src/commands/absorb.test.ts` — add test cases for: `--route` parsing, `--route` + `--branch` composition, non-interactive hint output
- Update `static override usage` examples in `absorb.ts` to include `--no-prompt` and `--route` examples

## Decisions (resolved)

1. **`--route` accepts both indices and names.** Try integer parse first (1-based), fall back to substring match. Error on multiple matches. Names are preferred in hint output for stability.

2. **No summary confirmation prompt.** Per-file prompts provide enough control; an extra "proceed?" would be redundant.

3. **No "create new branch" option for unowned files.** Deferred — out of scope. `[skip]` is sufficient for now.

4. **Batch unowned files:** If there are many unowned files (>3), consider grouping them under a single "assign all to branch X" prompt with an "individually" escape hatch. Implementation detail — start with per-file prompts, optimize if it feels tedious in practice.

5. **`--branch` + `--route` composition:** `--branch` without positional files is a no-op when `--route` is present. Only errors if it's the sole routing mechanism with no files.

6. **Dedup:** `--route` and `--branch` entries are merged into `manualFiles` before classification, preventing double-prompting for already-routed files.
