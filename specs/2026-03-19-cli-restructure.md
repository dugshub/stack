# CLI Restructure: `st` with Noun Groups

> Restructure the flat 35-command CLI into `st stack ...` and `st branch ...` noun groups with curated top-level aliases. Rename binary from `stack` to `st`.

## Status: DRAFT (2026-03-19)

---

## Motivation

35 flat commands create a wall of text on `--help` and poor tab-completion UX. Users can't discover commands because there's no structure. The `gh` CLI (noun-verb: `gh pr create`, `gh repo clone`) proves this pattern scales cleanly. Docker's flat-to-grouped evolution is the exact transition we're making.

## Design Principles

1. **Binary: `st`** — 2 chars. Matches `gh`, `jj`, `rg`. Fast to type 100x/day.
2. **Two noun groups** — `stack` and `branch`. Natural mental model.
3. **Curated top-level aliases** — 8-10 most common commands available without the noun prefix.
4. **Three tiers of help** — bare `st` (dashboard), `st -h` (concise), `st stack -h` / `st branch -h` (full group).
5. **Backward compatible** — `stack` binary still works (both names in package.json `bin`). Old flat commands still work via aliases during transition.

---

## Command Taxonomy

### `st stack ...` — Operations on the stack as a whole

| Command | Description |
|---|---|
| `st stack create <name>` | Start a new stack |
| `st stack delete <name>` | Remove a stack |
| `st stack status` | Show stack and PR status |
| `st stack submit` | Push branches, create/update PRs |
| `st stack sync` | Clean up after merges |
| `st stack merge` | Merge entire stack |
| `st stack restack` | Rebase downstream branches |
| `st stack check <cmd>` | Run command on every branch |
| `st stack graph` | Show dependency graph |

### `st branch ...` — Operations on a branch within the stack

| Command | Description |
|---|---|
| `st branch up` | Move up (toward trunk) |
| `st branch down` | Move down (away from trunk) |
| `st branch top` | Jump to top of stack |
| `st branch bottom` | Jump to bottom of stack |
| `st branch nav` | Interactive branch picker |
| `st branch track` | Add current branch to stack |
| `st branch remove` | Remove from stack |
| `st branch pop` | Pop branch, keep changes |
| `st branch fold` | Fold into parent |
| `st branch rename <name>` | Rename branch |
| `st branch move <up\|down\|N>` | Reposition in stack |
| `st branch insert` | Insert new branch |
| `st branch reorder` | Reorder branches |
| `st branch modify` | Amend and restack |
| `st branch absorb` | Route fixes to correct branches |
| `st branch split` | Split changes into stack |

### Top-level (no noun prefix) — Always available

**Workflow interrupts:**

| Command | Description |
|---|---|
| `st continue` | Continue after conflicts |
| `st abort` | Abort in-progress restack |
| `st undo` | Undo last command |

**Meta:**

| Command | Description |
|---|---|
| `st config` | View/update settings |
| `st daemon` | Manage background daemon |
| `st completions` | Shell tab completions |
| `st init` | Install Claude Code skills |
| `st update` | Self-update |

**Magic routing (existing behavior):**

| Input | Behavior |
|---|---|
| `st` | Dashboard (existing) |
| `st <name>` | Switch to stack by name |
| `st <N>` | Jump to branch N (routes to nav) |

### Top-level convenience aliases

These are the 80% commands — available at top level AND under their noun group. Users type the short form; help teaches the grouped form.

| Alias | Routes to |
|---|---|
| `st create` | `st stack create` |
| `st status` | `st stack status` |
| `st submit` | `st stack submit` |
| `st sync` | `st stack sync` |
| `st up` | `st branch up` |
| `st down` | `st branch down` |
| `st modify` | `st branch modify` |

---

## Three-Tier Help Design

### Tier 1: `st` (bare, no args) — Dashboard

No change from current behavior. Shows stacks, hints, contextual suggestions.

### Tier 2: `st -h` — Concise summary

Shows only the curated aliases + group pointers. NOT 35 commands.

```
  st v0.6.0
  Stacked PRs for GitHub

    st <name>               Switch to a stack
    st <number>             Jump to branch N
    st create <name>        Start a new stack
    st status               Show stack status
    st submit               Push branches, create PRs
    st up / down            Navigate branches
    st modify               Amend and restack
    st sync                 Clean up after merges

    st stack ...            Stack operations (create, delete, submit, merge, ...)
    st branch ...           Branch operations (up, down, fold, move, insert, ...)

    st continue / abort     Conflict resolution
    st undo                 Undo last command
    st config               View/update settings

  Run st stack -h or st branch -h for full command lists
```

### Tier 3: `st stack` / `st branch` — Group help

Shown when noun is invoked with no verb (or with `-h`).

```
$ st stack

  Stack commands:

    st stack create <name>      Start a new stack
    st stack delete <name>      Remove a stack
    st stack status             Show stack and PR status
    st stack submit             Push branches, create/update PRs
    st stack sync               Clean up after merges
    st stack merge              Merge entire stack
    st stack restack            Rebase downstream branches
    st stack check <cmd>        Run command on every branch
    st stack graph              Show dependency graph

  Run st stack <command> -h for details

$ st branch

  Branch commands:

    st branch up / down         Navigate up/down
    st branch top / bottom      Jump to ends
    st branch nav               Interactive picker
    st branch track             Add current branch
    st branch remove            Remove from stack
    st branch pop               Pop, keep changes
    st branch fold              Fold into parent
    st branch rename <name>     Rename branch
    st branch move <dir>        Reposition in stack
    st branch insert            Insert new branch
    st branch reorder           Reorder branches
    st branch modify            Amend and restack
    st branch absorb            Route fixes to branches
    st branch split             Split into stack

  Run st branch <command> -h for details
```

---

## Implementation Plan

### Phase 1: Add noun-group paths to existing commands

Every command gets a second path under its noun group. The existing flat path stays as an alias (or convenience shortcut).

**Clipanion supports multiple paths natively:**

```typescript
// Before:
static override paths = [['submit']];

// After — primary path is grouped, alias is flat:
static override paths = [['stack', 'submit'], ['submit']];
```

**Commands getting `['stack', ...]` primary path:**
- `create.ts` → `[['stack', 'create'], ['create']]`
- `delete.ts` → `[['stack', 'delete']]` (no top-level alias)
- `status.ts` → `[['stack', 'status'], ['status']]`
- `submit.ts` → `[['stack', 'submit'], ['submit']]`
- `sync.ts` → `[['stack', 'sync'], ['sync']]`
- `merge.ts` → `[['stack', 'merge']]`
- `restack.ts` → `[['stack', 'restack']]`
- `check.ts` → `[['stack', 'check']]`
- `graph.ts` → `[['stack', 'graph']]`

**Commands getting `['branch', ...]` primary path:**
- `up.ts` → `[['branch', 'up'], ['up']]`
- `down.ts` → `[['branch', 'down'], ['down']]`
- `top.ts` → `[['branch', 'top']]`
- `bottom.ts` → `[['branch', 'bottom']]`
- `nav.ts` → `[['branch', 'nav']]`
- `track.ts` → `[['branch', 'track']]`
- `remove.ts` → `[['branch', 'remove']]`
- `pop.ts` → `[['branch', 'pop']]`
- `fold.ts` → `[['branch', 'fold']]`
- `rename.ts` → `[['branch', 'rename']]`
- `move.ts` → `[['branch', 'move']]`
- `insert.ts` → `[['branch', 'insert']]`
- `reorder.ts` → `[['branch', 'reorder']]`
- `modify.ts` → `[['branch', 'modify'], ['modify']]`
- `absorb.ts` → `[['branch', 'absorb']]`
- `split.ts` → `[['branch', 'split']]`

**Commands staying top-level only (no noun group):**
- `continue.ts` → `[['continue']]` (unchanged)
- `abort.ts` → `[['abort']]` (unchanged)
- `undo.ts` → `[['undo']]` (unchanged)
- `config.ts` → `[['config']]` (unchanged)
- `daemon.ts` → `[['daemon']]` (unchanged)
- `completions.ts` → `[['completions']]` (unchanged)
- `init.ts` → `[['init']]` (unchanged)
- `update.ts` → `[['update']]` (unchanged)
- `default.ts` → `[Command.Default]` (unchanged)

### Phase 2: Noun-group help commands

Create two new command files that handle bare `st stack` and `st branch` invocations:

**`src/commands/stack-group.ts`** — Registered at path `[['stack']]`. When invoked with no subcommand, renders the stack group help screen. This is a clipanion command with `Command.Default`-like behavior scoped to the `stack` prefix.

**`src/commands/branch-group.ts`** — Same pattern for `[['branch']]`.

These render the Tier 3 help screens defined above using the existing `theme` helpers.

### Phase 3: Update `cli.ts`

1. **Binary name**: Change `binaryName` from `'stack'` to `'st'` in the Cli constructor.
2. **Update `showHelp()`**: Replace the full 35-command list with the Tier 2 concise help screen.
3. **Update `showFirstRun()`**: Use `st` instead of `stack` in examples.
4. **Update dashboard footer**: `st <name> to switch   st create <name> to start`
5. **Update `noRepoRequired`**: No changes needed (command names unchanged).
6. **Update numeric routing**: `st 3` still routes to `['nav', '3']` (no change, nav has branch alias).

### Phase 4: Update `package.json` bin

```json
"bin": {
  "st": "./src/cli.ts",
  "stack": "./src/cli.ts"
}
```

Both binary names point to the same entry point. Existing `stack` users aren't broken.

### Phase 5: Update completions

**`src/commands/completions.ts`** needs significant updates:

1. Update the hardcoded command list to include noun-group forms
2. Add second-level completions: `st stack <tab>` shows stack subcommands, `st branch <tab>` shows branch subcommands
3. Update binary name references from `stack` to `st`
4. Update both zsh and bash completion generators
5. Keep completing `stack` binary too for backward compat

### Phase 6: Update ai-docs

**`src/lib/ai-docs.ts`** needs updates:

1. Group commands under `stack` and `branch` headings in the overview
2. Update all example strings from `stack <cmd>` to `st <cmd>` (and `st stack <cmd>` / `st branch <cmd>`)
3. Update individual command docs to show grouped paths

### Phase 7: Update internal command references

Search all files for strings like `stack submit`, `stack create`, etc. that appear in user-facing messages (ui.info, ui.error, theme.command, etc.) and update to `st` prefix. Key files:

- `src/lib/dashboard.ts` — footer text
- `src/lib/hints.ts` — contextual hint text
- `src/commands/*.ts` — error messages, help text, examples in `Command.Usage()`
- `src/lib/comment.ts` — PR comment text (may reference commands)

### Phase 8: Update documentation

- `CLAUDE.md` — update examples to use `st`
- `README.md` (if exists)
- Spec files — no need to update, they're historical

---

## Edge Cases & Decisions

### DefaultCommand conflict
The `DefaultCommand` at `[Command.Default]` catches `st <name>` for stack switching. With noun groups, `st stack` and `st branch` are explicit paths that clipanion resolves BEFORE the default command. No conflict — clipanion matches the most specific path first.

### `st stack status` vs `st status`
Both work. The grouped form is canonical (shown in `st stack -h`), the flat form is a convenience alias (shown in `st -h`). Clipanion handles multiple paths per command natively.

### Backward compat for scripts
`stack submit`, `stack status`, etc. all still work because:
1. `stack` binary still exists in `bin`
2. Flat paths are kept as aliases on commands that have top-level shortcuts
3. Commands without top-level aliases (like `stack graph`) still work via the `stack` binary

For commands that lose their flat alias (e.g., `graph` is only `st stack graph`, not `st graph`), the old `stack graph` still works because the `stack` binary exists. But `st graph` would hit the DefaultCommand and try to find a stack named "graph". This is acceptable — these are low-frequency commands.

**Decision: Keep ALL flat paths as secondary aliases during v0.x.** Remove them in v1.0 once users have migrated. This means every command has both `[['stack', 'submit'], ['submit']]` not just the convenience ones. The difference is which aliases appear in help text.

### Tab completion priority
When typing `st s<tab>`, both `stack` (the noun group) and `submit`, `status`, `sync`, `split` match. Completions should show the noun group first, then aliases. The shell completion script controls this ordering.

---

## TUI Evolution (Future)

This restructure enables a natural TUI path:

1. **Now**: `st branch` with no args shows group help
2. **Next**: `st branch` with no args launches the interactive branch picker (absorbs `nav`). `st stack` with no args launches an interactive stack picker (absorbs dashboard).
3. **Later**: `st` bare becomes a full two-pane TUI — stacks left, branches right. Every noun-verb maps to a keybinding. The CLI and TUI share semantics.

The noun groups mean the TUI practically designs itself: each noun is a view, each verb is an action within that view.

---

## Files Changed

| File | Change |
|---|---|
| `package.json` | Add `st` to bin, keep `stack` |
| `src/cli.ts` | binaryName → `st`, rewrite `showHelp()`, update `showFirstRun()` |
| `src/commands/stack-group.ts` | **NEW** — Stack noun-group help |
| `src/commands/branch-group.ts` | **NEW** — Branch noun-group help |
| `src/commands/create.ts` | paths → `[['stack', 'create'], ['create']]` |
| `src/commands/delete.ts` | paths → `[['stack', 'delete'], ['delete']]` |
| `src/commands/status.ts` | paths → `[['stack', 'status'], ['status']]` |
| `src/commands/submit.ts` | paths → `[['stack', 'submit'], ['submit']]` |
| `src/commands/sync.ts` | paths → `[['stack', 'sync'], ['sync']]` |
| `src/commands/merge.ts` | paths → `[['stack', 'merge'], ['merge']]` |
| `src/commands/restack.ts` | paths → `[['stack', 'restack'], ['restack']]` |
| `src/commands/check.ts` | paths → `[['stack', 'check'], ['check']]` |
| `src/commands/graph.ts` | paths → `[['stack', 'graph'], ['graph']]` |
| `src/commands/up.ts` | paths → `[['branch', 'up'], ['up']]` |
| `src/commands/down.ts` | paths → `[['branch', 'down'], ['down']]` |
| `src/commands/top.ts` | paths → `[['branch', 'top'], ['top']]` |
| `src/commands/bottom.ts` | paths → `[['branch', 'bottom'], ['bottom']]` |
| `src/commands/nav.ts` | paths → `[['branch', 'nav'], ['nav']]` |
| `src/commands/track.ts` | paths → `[['branch', 'track'], ['track']]` |
| `src/commands/remove.ts` | paths → `[['branch', 'remove'], ['remove']]` |
| `src/commands/pop.ts` | paths → `[['branch', 'pop'], ['pop']]` |
| `src/commands/fold.ts` | paths → `[['branch', 'fold'], ['fold']]` |
| `src/commands/rename.ts` | paths → `[['branch', 'rename'], ['rename']]` |
| `src/commands/move.ts` | paths → `[['branch', 'move'], ['move']]` |
| `src/commands/insert.ts` | paths → `[['branch', 'insert'], ['insert']]` |
| `src/commands/reorder.ts` | paths → `[['branch', 'reorder'], ['reorder']]` |
| `src/commands/modify.ts` | paths → `[['branch', 'modify'], ['modify']]` |
| `src/commands/absorb.ts` | paths → `[['branch', 'absorb'], ['absorb']]` |
| `src/commands/split.ts` | paths → `[['branch', 'split'], ['split']]` |
| `src/commands/completions.ts` | Rewrite for noun groups + `st` binary |
| `src/lib/ai-docs.ts` | Group commands, update examples to `st` |
| `src/lib/dashboard.ts` | Update text references to `st` |
| `src/lib/hints.ts` | Update command references to `st` |
| `src/commands/*.ts` (all) | Update `Command.Usage` examples to `st` prefix |
| `CLAUDE.md` | Update examples |

---

## Verification

```bash
# Grouped commands work
st stack create test-stack -d first-branch -y
st stack status
st branch down
st stack submit --dry-run

# Top-level aliases work
st create test2 -d something -y
st status
st down
st submit --dry-run

# Backward compat
stack submit --dry-run

# Help tiers
st -h                  # concise
st stack               # stack group help
st branch              # branch group help
st stack submit -h     # individual command help

# Tab completion
st s<tab>              # shows: stack, submit, status, sync, split
st stack <tab>         # shows: create, delete, status, submit, ...
st branch <tab>        # shows: up, down, top, bottom, nav, ...

# Magic routing still works
st my-stack-name       # switches to stack
st 3                   # jumps to branch 3
st                     # dashboard
```
