# Change stack trunk (re-parent a stack)

## Problem

Today, a stack's trunk is fixed at creation (`st create` / `st create --base`) or mutated implicitly by `sync` when the parent PR merges. There is no user-facing way to re-parent a stack after it exists. You cannot:

- Move a stack from `main` to `develop` (or any other integration branch).
- Convert a standalone stack into a dependent stack (rebase onto another stack's branch).
- Convert a dependent stack to standalone on demand (only `sync` can, and only after the parent merges).
- Move a dependent stack from one parent stack to another.

All of these are legitimate workflows — e.g. integration branch rename, "actually this belongs on top of feature-X", or undo-ing a bad `--base` choice at create time.

## Scope

**In:** One command that changes `stack.trunk` (and `dependsOn` when appropriate), rebases all branches onto the new base, updates the first PR's base on GitHub, and cascades to dependents.

**Out (phase 1):**
- Multi-parent/diamond re-parenting (`--also-base`). The existing multi-parent stack is phase-1-limited elsewhere; we match that constraint.
- Automatic detection ("you should move this stack"). User-initiated only.
- Bulk reparent (multiple stacks at once).

## UX — options considered

### Option A: `st stack base <new-base>` (recommended)

Mirrors `st create --base <branch>` exactly. The verb-less noun reads as "set the stack's base to this".

```
st stack base main                          # reparent onto main (default branch)
st stack base develop                       # reparent onto some other branch
st stack base user/other-stack/3-final      # reparent onto another stack's branch (auto-detected as dependent)
st stack base .                             # reparent onto current branch (matches create --base .)
st stack base --stack my-stack main         # explicit stack target
st stack base --dry-run main                # show what would happen
```

Flat alias: `st base <new-base>`.

**Pros:** Symmetric with `create --base`. Short. Noun form ("the base") reads naturally. The `.` shorthand carries over.
**Cons:** "base" is slightly overloaded with PR base; but the mental model is the same thing (what this stack sits on top of).

### Option B: `st stack reparent <new-base>`

Descriptive verb form. Same args.

**Pros:** Unambiguous about what it does.
**Cons:** Diverges from existing `--base` terminology. Longer.

### Option C: `st stack set-trunk <branch>`

Exposes the internal state name.

**Pros:** Literal. No ambiguity with "base".
**Cons:** "trunk" is internal jargon — users think in terms of `main` / `develop` / "the branch it's built on". And it suggests the new trunk must be main-like, which it doesn't (can be any branch or another stack's branch).

### Recommendation

**Option A: `st stack base <new-base>` + flat alias `st base`.**

Rationale: the user already learned `--base` at create time. Reusing the same word with the same resolution rules (branch name, `.`, auto-detect ownership by other stack) is zero cognitive overhead. The command becomes "change what I passed to `--base`." Noun form beats `set-base` for concision.

## Behavior

Given `st stack base <new-base> [--stack <name>] [--dry-run]`:

1. **Resolve the target stack** via `resolveStack` (same as restack/move/submit).
2. **Reject** if `stack.restackState` is non-null — finish or abort the restack first.
3. **Reject** if the stack has multiple parents (phase-1 limitation, same as restack).
4. **Resolve `<new-base>`** with the same logic as `CreateCommand.resolveBase`:
    - `.` → current branch.
    - Verify `git rev-parse --verify <new-base>` succeeds.
    - Scan all tracked stacks; if the branch belongs to one, that stack becomes the new primary parent (`dependsOn = [{stack, branch}]`). Otherwise clear `dependsOn`.
    - Reject if the new base belongs to **this** stack (can't depend on yourself).
    - Reject if making this stack depend on a stack that (transitively) depends on it (cycle detection — walk `dependsOn` chain).
5. **No-op check**: if the resolved new base equals `stack.trunk` *and* the resolved `dependsOn` is structurally equal to the current `dependsOn`, print "already based on X" and exit 0. Structural equality: same length, same `{stack, branch}` pairs in order (deep compare — not reference equality). Both fields must match; a trunk match with a `dependsOn` change is still a real re-parent and must proceed.
6. **Dry-run**: print current state (`trunk: X`, `dependsOn: [...]`, branches) and new state side-by-side. No mutations. Exit 0.
7. **Save undo snapshot** (`saveSnapshot('base')`). `saveSnapshot` accepts any label — `'base'` needs no registration.
8. **Update the first branch's PR base on GitHub first** (before any local mutation or rebase). If the first branch has a PR, call `gh.prEdit(prNumber, { base: <new-base-branch> })`. Rationale: GitHub PR base is idempotent and independent of local rebase state. Doing this *before* the rebase ensures that a mid-rebase conflict (which persists `restackState` and defers completion to `st continue`) doesn't leave the PR targeting the old base indefinitely — `st continue` does not re-run PR-base updates. Mid-stack PR bases are NOT touched; they still target the previous branch in the stack, which didn't move.
9. **Restack the stack onto the new base**:
    - Build `oldTips` from current branch tips (pre-mutation).
    - Mutate `stack.trunk = <new-base-branch-name>` and `stack.dependsOn` accordingly; `saveState` immediately so the mutation is durable before the rebase starts (matches what `sync.ts:79-83` does).
    - Rebase the first branch onto the new trunk via `rebaseBranch` with `parentRef = stack.trunk`, `fallbackOldBase = oldTips[firstBranch.name]`.
    - Cascade to the rest via `cascadeRebase` (same machinery `restack` uses).
    - On conflict, persist `restackState` with `fromIndex: -1` and exit 1 with the standard "run `st continue`" hint. `st continue` will read the already-mutated `stack.trunk` and finish the rebase correctly; the GitHub PR base was already updated in step 8.
10. **Cascade to dependent stacks** (see extraction note below). Rationale: any stack depending on *this* one needs to know its parent moved.
11. **Success output**: `Stack "X" now based on <new-base>` + position report.

## Validation rules (error messages)

- `Base branch "<x>" does not exist` — git rev-parse fails.
- `Cannot re-parent onto a branch in the same stack ("<x>")` — new base owned by target stack.
- `Circular dependency: "<target>" would depend on "<parent>" which already depends on it` — cycle detection.
- `Multi-parent stacks cannot be re-parented yet — coming in phase 2.` — consistent with restack.
- `A restack is in progress. Run "st continue" or "st abort" first.`

## Implementation plan

**New file:** `src/commands/base.ts`
- Class `BaseCommand extends Command`.
- `paths = [['stack', 'base'], ['base']]`.
- Options: `stackName (--stack,-s)`, `dryRun (--dry-run)`, `cascade (--cascade / --no-cascade)` — when set, bypasses the dependent-stack prompt; when unset, defaults to prompt-on-TTY / cascade-on-non-TTY (same shape as `RestackCommand.cascade`). Positional `newBase` (required).
- Reuses `resolveStack`, `loadAndRefreshState`, `saveSnapshot`, `rebaseBranch`, `cascadeRebase`, `saveState`.
- Executes inside `git.withCleanWorktreeAsync`.

**Refactor:** Extract `resolveBase` logic from `src/commands/create.ts` into a new module (`src/lib/base-resolver.ts`). The current method consumes `this.base` and `this.alsoBase` from `CreateCommand`; the extracted form takes plain arguments:

```ts
interface ResolveBaseOpts {
  state: StackFile;
  base: string | undefined;        // raw --base value, or undefined
  alsoBase?: string[];             // only passed by create; base command does not pass this
  selfStackName?: string;          // base command passes this to reject self-reference
}
```

When `alsoBase` is absent/empty, the multi-parent code path is a no-op — behavior for `create` is unchanged. `base.ts` does not pass `alsoBase` (phase-1 rejects multi-parent up front). `create.ts` is updated to import the new helper. The self-reference check (`newBase` owned by `selfStackName`) lives inside the helper and short-circuits with a typed error.

**Cycle detection** is implemented separately in `base.ts`, not in the helper. It walks `dependsOn` transitively: starting from the resolved new primary parent stack, follow `state.stacks[p.stack].dependsOn` recursively. If `selfStackName` appears anywhere in the chain, reject. Do **not** reuse `findDependentStacks` (state.ts:136) — it's one level only.

**Refactor:** Extract `cascadeDependentStacks` into `src/lib/rebase.ts` as an exported async function so `restack.ts`, `continue.ts`, and `base.ts` all call it. The method is currently duplicated in `src/commands/restack.ts:147-244` *and* `src/commands/continue.ts:133-230` (identical bodies). Extraction collapses two copies to one plus the new callsite. Update both existing callsites (`restack.ts:66` and `restack.ts:141`, `continue.ts:125`) to call the imported function. The function closes over nothing instance-bound, so extraction is mechanical.

**PR base update:** Reuse `gh.prEdit(prNumber, { base })` the same way `move` does (src/commands/move.ts:162).

**Registration:** none required — `cli.ts:25-35` auto-discovers `src/commands/*.ts` via `readdirSync` and registers any exported `Command` subclass. Verified.

**`.` shorthand edge case:** when the user is on a branch *inside the target stack* and passes `.`, the resolver returns that branch as the new base. Step 4's self-reference check (new base owned by `selfStackName`) catches this and rejects with a clear error before any mutation.

**Help/docs:**
- Add usage examples in the `Command.Usage` block.
- Update `src/lib/ai-docs.ts` with the new command (grep shows all commands are listed there).
- Update the help dashboard table in `cli.ts` if appropriate — probably not top-level; it's a stack subcommand.

**Versioning:** patch bump (0.9.0 → 0.9.1), update `CHANGELOG.md`.

## Decisions (confirmed)

1. **Command name**: `st stack base <new-base>` + flat alias `st base`.
2. **Cascade**: default on with TTY prompt per dependent, matching `restack`. Accept `--cascade` to skip the prompt (force yes) and `--no-cascade` to skip entirely. Non-TTY defaults to cascade without prompt (same as restack today).
3. **PR bases**: only the first branch's PR base is updated on GitHub. Mid-stack PRs keep targeting the previous branch in the stack — those relationships didn't change.
4. **Cycle detection**: walk `dependsOn` transitively.
5. **First branch has no PR yet**: just rebase, nothing to update on GitHub.

## Test plan

Manual (no test suite exists for this project per CLAUDE.md):

- Standalone stack on `main` → `st base develop` → verify trunk changes, branches rebased, first PR base updated.
- Dependent stack on stack-A's branch → `st base main` → becomes standalone, `dependsOn` cleared.
- Standalone stack → `st base <branch-in-other-stack>` → becomes dependent, `dependsOn` set.
- `st base .` while on a branch in another stack → dependent link established.
- `st base <same-as-current>` → "already based on X", no-op.
- `st base <nonexistent>` → error.
- `st base <branch-in-same-stack>` → error.
- Create cycle (A depends on B, then `st base -s B <branch-in-A>`) → cycle error.
- Restack in progress → error telling user to continue/abort.
- Conflict during rebase → `restackState` persisted, `st continue` resumes correctly.
- Dependent stacks exist → they get restacked too (with TTY prompt).
- `--dry-run` prints plan with no mutations.
