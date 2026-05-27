# Research / open design areas

Notes on problems that are bigger than a single change — kept here so the next
person (or agent) picks up the framing, not just the code.

## Cross-workspace stack identity

**Shipped (0.9.8):** stack state is keyed by the *shared object store*, not the
working-tree path. `git.repoKey()` derives the key from
`git rev-parse --git-common-dir` (the main repo's `.git`, identical from every
worktree), so all worktrees of one repo share one canonical state file. Prior to
this, state keyed off `basename(--show-toplevel)`, so each worktree silently got
its own divorced state file named after the worktree directory.

The reason worktrees are safe to unify is that they share **refs and objects**:
`git rev-parse <branch>` returns the same SHA everywhere, and git forbids
checking out the same branch in two worktrees at once. So `tip` is globally
well-defined and there's no new divergence — `st`'s operations were already
worktree-aware (it rebases a branch in whatever worktree holds it via `cwd`;
see `rebase.ts`), only the state *key* lagged.

### The seam: logical vs physical state

The state file conflates two kinds of data:

- **Logical / portable** — branch order, parent relationships (`dependsOn`), PR
  numbers, trunk name. Identical no matter where the repo is checked out.
- **Physical / object-store-local** — `tip`, `parentTip`, `restackState`. Valid
  only against a specific object store; a SHA recorded in one store may not even
  exist in another.

Worktrees share both, so full unification is correct. **Separate clones** share
neither locally — only the remote. That's why `repoKey()` keys on the object
store: separate clones get distinct keys and stay isolated, so we never feed a
clone a SHA it can't resolve.

### Deferred: cross-clone / account-level sharing

Sharing a stack across two *separate clones* (or two machines) means sharing the
**logical** layer while letting each checkout compute its own **physical** SHAs.
The remote is already the shared source of truth for the logical layer — PR
numbers live on GitHub, and stack order is encoded in the navigation comments —
so an in-between tier would be a *cache/coordination point*, not a new source of
truth. Two plausible shapes, neither built yet:

- **A control** — opt-in `st` command on a fresh clone: "adopt this repo's stack
  from the remote" (reconstruct logical state from PRs + nav comments, compute
  tips locally). Cheap; no new infra.
- **An account/registry tier** — a machine-local or remote registry both clones
  consult. More powerful (live coordination, locks, presence) but real infra;
  only pays off past single-user.

`repoKey()` is forward-compatible with both: it's the bottom (object-store-local)
layer; an account/remote layer keyed by the `owner/repo` slug stacks on top of it
without conflict. Note the daemon (`server/stack-checks.ts`) already identifies
state by the `repo` slug field (it scans + matches, filename-agnostic), which is
the natural key for that upper tier.

### Known limitation (pre-existing)

`repoKey()` is still a basename, so two *different* repos with the same directory
name collide on one state file. This predates 0.9.8 and isn't worsened by it. The
slug-based key used by the daemon is the eventual fix, tied to the account tier
above.

## Squash-merge sync

When a stacked PR is squash-merged, the merge commit on trunk has a different SHA
than the branch tip `st` recorded, so naive rebases of dependents can replay
already-merged work or conflict. `st sync` and the daemon's cascade logic handle
the common cases; a fully general solution (robust across force-pushes,
out-of-band rebases, and partial merges) remains open.
