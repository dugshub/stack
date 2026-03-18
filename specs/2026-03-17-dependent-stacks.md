# Dependent Stacks (Branched Stacks)

> Allow a stack to branch off from a branch in another stack, with formal tracking of the relationship.

## Status: DRAFT (Validated 2026-03-17)

---

## Motivation

A 7-branch stack often contains logically separate features that share a common foundation. After branch 5 (e.g., "cache layer"), you may need a parallel workstream (e.g., "cache invalidation") that depends on branch 5 but shouldn't block branches 6-7 of the original stack.

Today there's no way to express this. You'd have to either:
- Cram everything into one linear stack (loses separation)
- Create an unrelated stack (loses the dependency relationship)

## Design: B→C (trunk override + dependsOn metadata)

### Core insight

The codebase is already trunk-agnostic. `submit`, `comment`, `status`, `ui`, `restack`, `absorb`, `push`, and the server-side `rebase-check.ts` all reference `stack.trunk` without assuming it's `main`. Setting trunk to a feature branch makes everything *mechanically* work. The `dependsOn` field adds the *semantic* layer for display, validation, and cross-stack sync.

**Verified trunk-agnostic:** `submit.ts` (3 refs — all PR base selection), `comment.ts` (1 ref — trunk row), `status.ts` (2 refs — JSON output), `ui.ts` (1 ref — tree header), `restack.ts` (2 refs — first branch rebase), `absorb.ts` (1 ref — ownership diff base), `push.ts` (0 direct refs — ancestry check is branch-to-branch), `rebase-check.ts` (2 refs — commit status checks, uses local `StackFile` interface).

> **Note:** `rebase-check.ts` defines its own local `StackFile` interface. It does not need `dependsOn` for its current function (posting commit checks), but should be updated if server-side logic ever needs dependency awareness.

### Type change

```typescript
interface Stack {
  trunk: string;                    // feature branch name when dependent
  dependsOn?: {                     // NEW — metadata for cross-stack awareness
    stack: string;                  // parent stack name
    branch: string;                 // branch name in parent stack
  };
  branches: Branch[];
  created: string;
  updated: string;
  restackState: RestackState | null;
}
```

`trunk` IS the mechanism. `dependsOn` IS the metadata. They must agree: `stack.trunk === stack.dependsOn.branch` when `dependsOn` is set.

> **Cross-reference:** The ordering operations spec (`2026-03-15-stack-ordering-operations.md`) Phase 3 independently proposes the same `dependsOn` field. This spec is the canonical definition. The ordering spec's `stack edit fork` should build on this implementation.

---

## Changes by command

### 1. `create` — add `--base` flag

```bash
# Create a stack that branches off branch 5 of another stack
stack create cache-invalidation --base dugshub/test-mergedown/5-cache-docs -d initial-setup

# Short form: if on a stack branch, use current branch as base
stack create cache-invalidation -d initial-setup --base .
```

**Algorithm:**
1. Resolve `--base` branch (`.` = current branch via `git.currentBranch()`)
2. Look up which stack owns the base branch — scan all `state.stacks[*].branches` for a name match
3. If found: set `trunk = baseBranch`, `dependsOn = { stack: parentStackName, branch: baseBranch }`
4. If not found (branch exists but isn't in a stack): set `trunk = baseBranch`, no `dependsOn` (standalone with custom trunk)
5. Validate: base branch must exist locally (`git.tryRun('rev-parse', '--verify', baseBranch)`)
6. Create first branch using `git.branchCreate(branchName, baseTip)` — this already exists at `git.ts:236` and creates a branch at a specific SHA without changing HEAD
7. Checkout the new branch
8. Set `parentTip` on first branch to `git.revParse(baseBranch)`

**Changes to `create.ts` — `explicit()` mode:**
- Add `--base` option (`Option.String('--base,-b', { ... })`)
- If `--base` provided: resolve base branch, compute `baseTip = git.revParse(baseBranch)`
- Use `git.branchCreate(branchName, baseTip)` + `git.checkout(branchName)` instead of `git.createBranch(branchName)` (which creates from HEAD)
- Set `trunk = baseBranch` instead of `git.defaultBranch()`
- Populate `dependsOn` when parent stack is identified

**Changes to `create.ts` — `retroactive()` mode:**
- Accept `--base` in retroactive mode too: `stack create name --from b1 b2 --base parent-branch`
- If `--base` provided: use it as trunk, populate `dependsOn`
- Otherwise: unchanged (uses `git.defaultBranch()`)

**`autoDetect()` mode:** No changes. Auto-detect infers stack name from current branch — if the user wants a dependent stack, they should use explicit mode with `--base`.

### 2. `submit` — no changes needed

Already uses `stack.trunk` for first branch base. Feature branch trunk works as-is.

### 3. `sync` — two-phase approach

**Phase 1 (MVP — steps 1-4):** Diagnostic logging only.
- After fast-forward attempt, if `dependsOn` is set, log:
  ```
  Syncing dependent stack "cache-invalidation" (base: dugshub/test-mergedown/5-cache-docs)
  ```
- Fast-forward of feature-branch trunk works normally (branch exists on origin after parent submits)
- If ff-only fails (parent was force-pushed after restack): current code warns and continues with local trunk state. **Known limitation:** this produces a silently stale rebase target. The user should run `stack restack` on the dependent stack after the parent stack restacks. Document this in help text.

**Phase 2 (guardrails — step 7):** Auto-convert when parent merges.
- In sync, after fetching, check if `dependsOn` is set AND trunk branch no longer exists on remote (`!git.hasRemoteRef(stack.trunk)`)
- If trunk is gone: the parent branch was merged
  - Determine the default branch: `git.defaultBranch()`
  - Update `stack.trunk = defaultBranch`
  - Clear `stack.dependsOn`
  - Log: `"Base branch ${oldTrunk} merged — stack is now standalone (trunk → ${defaultBranch})"`
  - Continue with normal sync (rebase remaining branches onto new trunk)

### 4. `merge` — guard for dependent stacks

**Add validation before starting merge job:**
```typescript
if (stack.dependsOn) {
  const parentStack = state.stacks[stack.dependsOn.stack];
  if (parentStack) {
    const baseBranch = parentStack.branches.find(
      b => b.name === stack.dependsOn!.branch
    );
    if (baseBranch?.pr != null) {
      const prStatus = gh.prView(baseBranch.pr);
      if (prStatus && prStatus.state !== 'MERGED') {
        ui.error(
          `This stack depends on ${stack.dependsOn.branch} (PR #${baseBranch.pr}), ` +
          `which hasn't been merged yet. Merge the parent stack "${stack.dependsOn.stack}" first.`
        );
        return 1;
      }
    }
  }
}
```

**Daemon race condition:** If a dependent stack's merge job is in-flight when the parent branch is deleted from remote (because parent stack merged), the daemon's `rebase-and-push` step will fail because `trunk` points to a deleted branch. This is an existing limitation of the async merge system — the merge job will report failure and the user can re-run after `stack sync` converts the stack to standalone. No special handling needed for MVP.

### 5. `status` / `ui` — show dependency

**In `stackTree()`:** When `dependsOn` is set, show the relationship in the trunk header:
```
     ↑ dugshub/test-mergedown/5-cache-docs (→ test-mergedown #5)
 #  Branch              PR    Status      Checks
 1  cache-invalidation  #458  👀 Review   ✅ Pass
 2  cache-eviction      #459  ⬜ Draft
```

The `(→ test-mergedown #5)` hint is derived from `dependsOn.stack` + finding the branch's index in the parent stack. `stackTree` already receives `stack: Stack`, so it has access to `dependsOn`. To resolve the position index, pass `state: StackFile` to `stackTree` (new optional param) or pre-compute the hint string.

**In JSON output:** Include `dependsOn` field as-is (already works — JSON.stringify includes all fields).

### 6. `comment` — show dependency in PR comment

**When `dependsOn` is set**, the trunk row changes:

Current: `| | \`main\` | |`
New: `| | ↳ \`test-mergedown\` #5 | |`

**Signature change:** `generateComment` currently takes `(stack, currentPrNumber, prStatuses, repoUrl)`. It already has access to `stack.dependsOn`. To show the parent stack name and position:
- Derive from `dependsOn.stack` (stack name) and `dependsOn.branch` (branch name)
- The position number can be parsed from the branch name pattern (`user/stack/N-desc`)
- No need for full `StackFile` access — `parseBranchName(dependsOn.branch)?.index` gives the position

```typescript
// In generateComment, replace trunk row:
if (stack.dependsOn) {
  const parsed = parseBranchName(stack.dependsOn.branch);
  const pos = parsed ? ` #${parsed.index}` : '';
  lines.push(`| | ↳ \`${stack.dependsOn.stack}\`${pos} | |`);
} else {
  lines.push(`| | \`${stack.trunk}\` | |`);
}
```

### 7. `delete` / `remove` — cross-stack validation

**When deleting a stack or removing a branch:**
1. Scan all stacks for `dependsOn` references to this stack/branch
2. If found: warn that dependent stacks exist
3. Don't block — just warn. The dependent stack still works (trunk branch still exists in git), it just has a dangling metadata link that `sync` will clean up.

### 8. Other commands — no changes needed

- **`restack`** — uses `stack.trunk` for first branch. `parentTip` tracking handles fork-point correctly.
- **`absorb`** — uses `stack.trunk` as diff base for bottom branch. Feature branch trunk gives correct ownership map.
- **`push`** — ancestry check is branch-to-branch (`isAncestor(topBranch, currentBranch)`). No trunk reference.
- **`nav`** — shows trunk in "already at bottom" message. Works with any trunk value.

---

## Cross-stack sync (future enhancement)

When the parent stack's base branch is updated (e.g., after `stack restack` in parent), dependent stacks need rebasing. This could be:

**Option A — Manual:** User runs `stack sync` or `stack restack` on the dependent stack. It picks up the new trunk tip via fast-forward.

**Option B — Automatic cascade:** After any operation that updates a branch, scan for dependent stacks and offer to restack them:
```
Branch "5-cache-docs" updated. Dependent stack "cache-invalidation" may need restacking.
Run: stack restack --stack cache-invalidation
```

**Recommendation:** Start with Option A. Option B is a daemon enhancement later.

---

## Edge cases

### Parent branch gets merged
Handled by sync Phase 2 (step 7): detect trunk branch missing from remote → auto-convert to standalone stack with `trunk = defaultBranch`, clear `dependsOn`.

### Parent stack gets deleted
- `dependsOn` becomes a dangling reference
- The trunk branch still exists in git (delete doesn't delete branches by default)
- `sync`/`status` should detect the dangling reference and warn
- User can clear it manually or sync auto-clears when trunk branch is gone from remote

### Force-pushed parent branch
- `sync` fast-forward fails, warns, continues with local state
- **Known limitation:** rebase uses stale trunk tip
- **Workaround:** user runs `git fetch && git checkout <trunk> && git reset --hard origin/<trunk>` then `stack restack --stack <dependent>`
- **Future fix:** sync could `git reset --hard origin/<trunk>` for dependent stacks (not for main/master — too dangerous)

---

## Implementation order

1. **Types** — add `dependsOn` to Stack interface
2. **Create** — add `--base` flag to `explicit()` and `retroactive()`, populate trunk + dependsOn
3. **Status/UI** — show dependency in tree header
4. **Comment** — show parent stack in PR navigation comment (use `parseBranchName` for position)
5. **Merge** — add guard for dependent stacks
6. **Delete/Remove** — add cross-stack reference warning
7. **Sync** — detect missing trunk on remote → auto-convert to standalone

Steps 1-4 are the minimum viable feature. Steps 5-7 are guardrails.

---

## Scope boundaries

**In scope:**
- Creating dependent stacks with `--base` (explicit and retroactive modes)
- Display of dependency relationships (status, comment)
- Guards against premature merge
- Auto-conversion to standalone when parent branch is merged

**Out of scope (future):**
- Automatic cross-stack cascade restack
- `stack branch transfer` between stacks
- `stack edit merge` (combining stacks)
- Interactive dependency graph visualization
- Daemon-triggered dependent stack sync
- `autoDetect()` mode for dependent stacks
- Server-side `dependsOn` awareness in `rebase-check.ts`
