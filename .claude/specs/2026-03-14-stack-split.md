# Stack Split — Declarative Stack Creation from Dirty Working Tree

## Goal

`stack split` takes uncommitted changes and splits them into a stacked set of branches in one shot. Declare the split with patterns (globs, regexes, folder grouping), see a detailed dry-run with +/- stats, then execute.

## Context

Currently, creating a stack from a batch of uncommitted work requires manually running `stack create`, `git add`, `git commit`, `stack push` in a loop. `stack split` automates the entire sequence with a single declarative command.

Existing patterns to reuse:
- `src/commands/absorb.ts` — already does file-to-branch routing, stash management, and selective content restoration
- `src/lib/git.ts` — git operations, `dirtyFiles()`, `isDirty()`
- `src/lib/state.ts` — stack state persistence
- `src/lib/branch.ts` — branch name generation (`parseBranchName`, `descriptionToTitle`)
- `Bun.Glob` — built-in glob matching (zero deps)

## UX

### Pattern-based split
```bash
stack split \
  "gh-additions:src/lib/gh.ts" \
  "server-core:src/server/**:!src/server/rebase-check.ts" \
  "rebase-check:src/server/rebase-check.ts" \
  "cli-wiring:src/commands/**:src/cli.ts"
```

Each arg: `branch-name:pattern[:pattern...]`
- Globs: `src/server/**`
- Negations: `!src/server/rebase-check.ts`
- Regex (hunk-level): `/MergeCommand/` — only stage hunks matching this pattern
- First-match-wins when files match multiple entries

### Auto-split by folder
```bash
stack split --by-folder
```
Groups by top-level directory under `src/` (e.g., `src/server/` → one branch, `src/commands/` → another).

### Dry run with stats
```bash
stack split --dry-run "gh-additions:src/lib/gh.ts" "server-core:src/server/**"
```

Output:
```
  Split Plan for stack "merge"
  ══════════════════════════════════════════════════════════

  1. dug/merge/1-gh-additions                      +34  -0
     src/lib/
       gh.ts                                       +34  -0

  2. dug/merge/2-server-core                       +312  -0
     src/server/
       types.ts (new)                               +62  -0
       state.ts (new)                               +85  -0
       clone.ts (new)                              +128  -0
       webhook.ts (new)                             +37  -0

  ──────────────────────────────────────────────────────────
  Total                                           +346  -0
  Files: 5 (4 new, 1 modified)

  ⚠ Unassigned changes (3 files):
     src/commands/merge.ts (new)                   +180  -0
     src/commands/sync.ts                           +18  -0
     src/cli.ts                                      +3  -0
```

## V1 Scope

V1 is **whole-file glob splitting only**. This covers 90%+ of real-world splits.

Deferred to v2:
- Hunk-level regex splitting (`/pattern/`) — requires diff parsing, offset recomputation, partial patch reconstruction
- `--by-folder` auto-grouping
- LSP dependency ordering

## Architecture

### Components

```
src/lib/split.ts          — Pure logic: parse specs, match files, build plan
src/commands/split.ts     — CLI command: options, validation, execution, rendering
```

### Data Structures

```typescript
interface SplitPattern {
  glob: string;
  negated: boolean;
}

interface SplitEntry {
  branchDescription: string;
  patterns: SplitPattern[];
}

interface FileStats {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
}

interface SplitPlanEntry {
  branchDescription: string;
  branchName: string;        // full: user/stack/N-description
  files: FileStats[];
  totalAdded: number;
  totalRemoved: number;
}

interface SplitPlan {
  stackName: string;
  trunk: string;
  entries: SplitPlanEntry[];
  unassigned: FileStats[];
  totalAdded: number;
  totalRemoved: number;
  totalFiles: number;
  newFiles: number;
}
```

## Plan

### Step 1: Split Library — Pattern Parsing

- File: `src/lib/split.ts`
- Function: `parseSplitArgs(args: string[]): SplitEntry[]`
- Parse `branch-name:pattern[:pattern...]` format
- For each pattern segment:
  - `!...` → negated glob
  - everything else → glob
- Validate: at least one non-negated pattern per entry

### Step 2: Split Library — File Matching

- File: `src/lib/split.ts`
- Function: `matchFiles(entry: SplitEntry, allFiles: string[], claimed: Set<string>): string[]`
- Use `Bun.Glob` for glob matching
- Apply inclusions first, then subtract negations
- Skip files already in `claimed` set (first-match-wins)

### Step 3: Split Library — Diff Stats

- File: `src/lib/split.ts`
- Function: `getFileStats(files: string[]): FileStats[]`
- Run `git diff --numstat` for tracked modified files
- For untracked (new) files: count lines via `Bun.file().text()` + split
- Returns +/- per file, `isNew` flag

### Step 4: Split Library — Plan Builder

- File: `src/lib/split.ts`
- Function: `buildSplitPlan(opts: { stackName: string, trunk: string, user: string, entries: SplitEntry[] }): SplitPlan`
- Gets dirty files (modified + untracked) via `git.dirtyFiles()` + `git status --porcelain`
- For each entry: match files, compute stats
- Track claimed files via `Set<string>`; anything unclaimed goes to `unassigned`
- Validate: entries with zero matched files are warned and excluded
- Construct full branch names: `user/stackName/N-description`

### Step 5: Command — CLI Options & Validation

- File: `src/commands/split.ts`
- Clipanion command with:
  - `specs = Option.Rest()` — positional args (`branch:pattern:...`)
  - `dryRun = Option.Boolean('--dry-run', false)`
  - `name = Option.String('--name,-n', { required: false })` — stack name
- Validation:
  - Working tree must be dirty (modified or untracked files)
  - Cannot be in a restack
  - Must have `specs` (at least one positional arg)
  - No existing `stack-*-temp` stash entries
  - Stack name: from `--name`, or from current branch basename if not on trunk
  - Stack name must not already exist in state

### Step 6: Command — Dry Run Rendering

- File: `src/commands/split.ts`
- Function: `renderPlan(plan: SplitPlan): void`
- Uses `ui.*` and `theme.*` for consistent styling
- Output structure:
  ```
  Header: "Split Plan for stack <name>"
  For each entry:
    Branch name + total +/-
    Files grouped by folder, each with +/- and (new) marker
  Separator
  Total: +N -M, X files (Y new, Z modified)
  Unassigned warning (if any)
  ```

### Step 7: Command — Execution

- File: `src/commands/split.ts`
- Pattern follows `absorb.ts` (stash/restore approach):

```
1. Validate: no in-progress restack, no existing stack-*-temp stash
2. Read all dirty file contents into memory (Map<path, Buffer | null>)
   - Modified files: read current content
   - New (untracked) files: read current content
   - Deleted files: null
3. Record stash count: git stash list | wc -l
4. git stash push -u -m "stack-split-temp"
5. Verify stash was created (stash count increased)

6. try {
     For each plan entry (i = 0 to N):
       a. If i === 0: create stack in state + first branch from trunk
          Else: git checkout -b <branch> (from previous branch)
       b. RESET working tree to match HEAD (clean slate each iteration):
          - git checkout -- .
          - git clean -fd
       c. Write ONLY this entry's matched file contents from memory:
          - For new files: create parent dirs, write file
          - For modified files: overwrite with saved content
          - For deleted files: git rm <file>
       d. git add <matched files>
       e. Verify something is staged (git diff --cached --quiet → should fail)
          If nothing staged: warn "empty entry", skip branch
       f. git commit -m <title derived from branch description>
       g. Record branch in stack state with tip = git rev-parse HEAD

     Save stack state

   } catch (error) {
     ROLLBACK:
     - Delete any branches created during this run
     - git checkout <trunk>
     - git stash pop (restore original dirty state)
     - Remove stack from state if newly created
     - Re-throw or report error
   }

7. Restore unassigned files to working tree:
   - Write unassigned file contents back from memory
8. Drop the stash: git stash drop (targeted by "stack-split-temp" message)
9. Report results
```

**Key fix: clean working tree between iterations.** Step 6b resets the working tree before each branch's files are written. This prevents prior branches' files from bleeding into later branches.

**Key fix: rollback on failure.** The try/catch wrapping the loop ensures that on any failure, created branches are deleted, stash is restored, and the user is back where they started.

**Key fix: stash cleanup.** The stash is tracked by message and dropped explicitly after success. On failure, it's popped to restore the original state.

### Step 8: Git Helpers

- File: `src/lib/git.ts`
- Add:
  - `diffNumstat(): Array<{ path: string, added: number, removed: number }>` — parse `git diff --numstat`
  - `stashPush(opts: { includeUntracked?: boolean, message?: string }): void`
  - `stashPop(): void`
  - `stashDrop(message: string): void` — find stash by message, drop it
  - `cleanWorkingTree(): void` — `git checkout -- . && git clean -fd`
  - `allDirtyFiles(): string[]` — combines modified + untracked (uses `git status --porcelain`)

### Step 9: Register Command

- File: `src/cli.ts`
- Import and register `SplitCommand`
- Add to help text: `split [specs...]   Split changes into a stack`

## Future (v2)

- **Hunk-level regex splitting** (`/pattern/`): Parse diffs, filter hunks by regex, reconstruct partial patches with offset recomputation, apply via `git apply --cached`. Requires careful handling of `@@` header arithmetic.
- **`--by-folder`**: Auto-group files by directory structure.
- **LSP dependency ordering**: Query import graphs, topologically sort entries so types/interfaces come before consumers. Plugs in as a transform on `SplitEntry[]` before plan building.

## Acceptance Criteria

- [ ] `stack split "name:pattern" "name:pattern"` creates a stack from dirty working tree
- [ ] Glob patterns match files correctly (inclusion + negation)
- [ ] `--dry-run` shows detailed plan with +/- per file, per folder, per branch, and totals
- [ ] Unassigned files warned in dry-run and preserved in working tree after execution
- [ ] Stack state correctly created with all branches tracked
- [ ] Each branch contains only its own changes (clean diffs between branches)
- [ ] Untracked (new) files handled correctly
- [ ] Modified (existing) files handled correctly
- [ ] First-match-wins for overlapping patterns
- [ ] Rollback on failure: branches deleted, stash restored, user back to original state
- [ ] Working tree reset between iterations (no cross-branch contamination)
- [ ] Empty entries (zero matched files) warned and skipped

## Open Questions

1. **Stack name inference**: If the user doesn't pass `--name`, how do we pick a stack name? Options: derive from current branch, prompt, or require it.
   - **Lean**: Require `--name` or derive from current branch name. No prompting.

2. **Commit messages**: Auto-derive from branch description (like submit does), or let user customize?
   - **Lean**: Auto-derive. `"Add gh additions"` from `gh-additions`. User can amend later.

3. **Existing stack**: If a stack already exists and user is at the top, extend it? Or require a new stack?
   - **Lean**: Require no existing stack for v1. Error if stack name already exists.

4. **Staged vs unstaged**: Should we handle already-staged changes too?
   - **Lean**: Yes — include both staged and unstaged. Unified view of all uncommitted changes.
