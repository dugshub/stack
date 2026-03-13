# Research: Solving the Squash-Merge Problem in Stack Sync

## Context

We built a CLI tool (`stack`) that manages stacked PRs — a Graphite replacement. During dogfooding we hit the hardest edge case in stacking: **post-squash-merge sync**.

### The Problem

When the bottom PR in a stack is squash-merged on GitHub:

1. GitHub creates a **single new commit** on main that contains all the changes
2. The original branch commits are **gone from main's history** (different SHAs)
3. Downstream branches still contain the original (pre-squash) commits as ancestors
4. `git rebase --onto main <old-tip> <next-branch>` replays those original commits
5. Git doesn't recognize them as already applied → **conflicts with their own squashed content**

This means every `stack sync` after a squash-merge produces spurious conflicts that the user has to manually resolve, even when there's no real divergence.

### What We Need

A strategy to detect that commits have already been applied (via squash) and skip them during rebase. This must work **client-side only** — we don't have a server component like Graphite.

## Research Tasks

### 1. How Graphite Handles This

- Does Graphite's server detect the merge event and automatically rebase/retarget downstream branches?
- What does `gt sync` do client-side vs what happens server-side?
- Does Graphite's merge queue do something special (e.g., rebase-merge instead of squash)?
- Check Graphite blog posts about "automatic rebase after merge"
- Check the open-source forks (charcoal, freephite) for implementation details

### 2. Git's Built-in Squash Detection

Research these git mechanisms:

- **`git patch-id`**: Generates a hash of the *diff content* (ignoring commit metadata). Two commits with the same patch-id are semantically equivalent even with different SHAs. Can we use this to detect already-squashed commits?
- **`git rebase` with `--fork-point`**: Does fork-point detection help with squash-merge scenarios?
- **`git range-diff`**: Compares two commit ranges — could detect which commits in the old range are "equivalent" to the squash commit
- **`git cherry`**: Lists commits not yet applied to upstream — uses patch-id internally
- **`git rebase --onto` with `--reapply-cherry-picks` / `--no-reapply-cherry-picks`**: In Git 2.44+, rebase can auto-skip cherry-picked commits. Does this work for squash-merged commits?

### 3. Other Stacking Tools

- **ghstack** (Facebook): How does it handle squash-merge? It uses a different model (one commit per PR)
- **spr** (Eighty Four): Same question
- **git-town**: Same question
- **Aviator MergeQueue**: Do they have special handling?
- **GitHub's native "Update branch" button**: What does it do under the hood?

### 4. Possible Client-Side Solutions

Evaluate these approaches:

#### A. Patch-ID Skip Strategy
Before rebasing, compute `git patch-id` for all commits in the range to be rebased AND for the squash commit on main. Skip commits whose patch-id matches a subset of the squash. Risk: squash combines N commits into 1, so individual patch-ids won't match the combined diff.

#### B. Diff-Based Rebase
Instead of `git rebase --onto`, use `git diff <old-base>..<branch> | git apply` on top of the new base. This applies only the *incremental* changes from this branch, ignoring shared history. Risk: loses commit metadata, may not handle renames.

#### C. Tree Comparison
After the squash-merge, compare the tree of the downstream branch against main. If the diff is only the new commits unique to this branch, we can create a new branch from main and cherry-pick only those commits. Use `git log --cherry-pick --right-only main...<branch>` to find truly unique commits.

#### D. Rebase with Empty Commit Detection
Run the rebase and detect when a commit becomes empty (content already applied). `git rebase` with `--empty=drop` (Git 2.43+) automatically drops commits that become empty after rebase. This might "just work" for the squash case.

#### E. Pre-rebase Branch Reset
Before rebasing, reset the downstream branch to remove commits that were part of the merged PR. We know which commits those are from the stack state (the merged branch's tip). So: `git rebase --onto main <merged-branch-old-tip> <next-branch>` should work IF we stored the right old-tip before the merge happened. **This is what our tool already does** — investigate why it's still conflicting.

### 5. Root Cause Analysis

Before implementing a solution, reproduce the exact failure:

1. Create a minimal 2-branch stack
2. Squash-merge branch 1
3. Run `git rebase --onto main <old-tip-of-branch-1> branch-2`
4. Examine: why does this conflict? Is `<old-tip>` correct? Is the issue that the squash commit has a different tree than the original commits?
5. Try `git rebase --onto main <old-tip> branch-2 --empty=drop` — does it help?
6. Try `git rebase --onto main <old-tip> branch-2 --no-reapply-cherry-picks` — does it help?

## Expected Outcome

A strategy (or combination) that makes `stack sync` handle squash-merges without spurious conflicts. Ideally zero user intervention for the common case (clean squash-merge, no actual conflicts).

## References

- Graphite docs: https://graphite.dev/docs
- Graphite blog on auto-rebase: https://graphite.dev/blog/automatic-rebase-after-merge
- Charcoal (Graphite fork): https://github.com/danerwilliams/charcoal
- Freephite (Graphite fork): https://github.com/agrinman/freephite
- git-patch-id docs: https://git-scm.com/docs/git-patch-id
- git-rebase --empty: https://git-scm.com/docs/git-rebase (search "empty")
- ghstack: https://github.com/ezyang/ghstack
- spr: https://github.com/ejoffe/spr
- git-town: https://github.com/git-town/git-town

## Source Code

- Stack CLI: https://github.com/dugshub/stack (private)
- Stack CLI in monorepo: `packages/stack/` in dealbrain
- Spec: `specs/2026-03-13-stack-cli.md` in dealbrain
