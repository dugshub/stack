# Stack Workflows

Canonical recipes. For exact flags on any command, run `st <command> --ai`. This file covers the flows the `--ai` index summarizes only briefly — especially dependent and diamond stacks.

## Create a stack

```bash
st create my-feature -d add-data-model   # new stack, first branch from HEAD
# write code, git add, git commit
st insert --after 1 -d add-api-endpoint  # add the next branch at a position
# write code, commit
st submit                                # push all + create draft PRs
```

- Auto-detect from the current branch: `st create` (no name).
- Adopt existing branches into a new stack: `st create my-feature --from b1 b2 b3` (or `st create my-feature b1 b2`).

### Dependent stack (build on another stack's branch)

```bash
st create cache -b user/other-stack/3-final -d initial   # base on a branch in another stack
st create cache -b .                                      # base on the CURRENT branch
```

Records `dependsOn`. When the base merges, `st sync` converts the stack to standalone.

### Diamond stack (one branch, two parents)

```bash
st create join -b feat/2-api --also-base feat-alt/1-schema -d merge-both
```

Joins both parents via a merge commit and records per-parent tips + the merge SHA, so `st restack` can re-create the merge when either parent moves. `--also-base` is repeatable. `st graph` shows all parents in the trunk header; `st submit` opens the PR against the primary (first) parent.

## Submit & PR descriptions

```bash
st submit               # force-with-lease push, create/update PRs, post nav comments (drafts by default)
st submit --dry-run     # preview the plan, push nothing
st submit --ready       # mark all PRs ready for review (staggered to preserve notification order)
st submit --describe    # generate AI PR descriptions (needs `st login`; or enable via `st config --describe`)
st submit --update      # regenerate AI descriptions on existing PRs
```

## Mid-stack edit (the power move)

```bash
st 2                    # jump to branch 2
# edit, git add
st modify               # amend the commit + cascade-rebase everything downstream
st submit               # push the rewritten branches + update PRs
```

`st modify -a` stages everything first; `st modify -m "msg"` rewrites the message; `st modify --no-restack` skips the cascade. After a plain mid-stack amend without `modify`, use `st restack` to cascade, then `st submit`.

## Sync after merges / trunk movement

```bash
st sync                 # fetch, fast-forward trunk, drop merged branches, rebase the rest
```

`st sync` rebases the stack whenever trunk advanced on the remote — even if no PR in the stack merged — so no manual `git pull` + `st restack`. Handles GitHub squash-merge by matching commit subjects.

## Merge the stack

```bash
st merge --dry-run      # preview the bottom-up plan
st merge --all          # enable auto-merge bottom-up; the daemon cascades rebase→retarget→auto-merge
st merge                # enable auto-merge on just the current branch's PR
st merge --now          # merge the current branch immediately (must target trunk)
```

The daemon watches each merge and advances the next PR. It also rebases **dependent** stacks onto the new trunk automatically when a base PR merges.

## Absorb (route fixes to the right branches)

```bash
st absorb --dry-run     # show which dirty file goes to which branch (by diff ownership)
st absorb               # commit each fix to its owning branch
st absorb --branch 5 SomeFile.tsx   # force a file onto branch 5 when ownership is ambiguous
st submit
```

## Split (organize a big diff into a stack)

```bash
st split --dry-run -n feature \
  "data-model:src/models/**" \
  "api:src/routes/**:src/middleware/**" \
  "ui:src/components/**:!src/components/legacy/**"
# review, then drop --dry-run
st submit
```

Spec syntax: `branch-desc:glob[:glob...]`, `!` prefix negates.

## Re-parent a stack (`st base`)

```bash
st base develop                      # move the stack from main onto develop
st base user/other-stack/3-final     # turn it into a dependent stack
st base .                            # base on the current branch
st base --dry-run main               # preview
```

Updates the first PR's base on GitHub before the local rebase, then cascades to dependent stacks (`--no-cascade` to skip). Rejects cycles and (for now) multi-parent/diamond stacks.

## Preview the navigation comment

```bash
st comment              # print the markdown st posts on the current branch's PR
st comment --all        # for every branch in the stack
```

## Navigate

```bash
st up / st down         # one step toward / away from trunk
st top / st bottom      # ends of the stack
st 3                    # jump to branch 3
st nav                  # interactive picker
st my-other-stack       # switch stacks by name
st graph / st graph --all / st graph --expand
st -i                   # interactive TUI graph
```

## Verify the whole stack

```bash
st check bun tsc --noEmit     # run on every branch, bottom to top
st check --bail bun test      # stop at the first failing branch
st check --from 3 bun build   # start at branch 3
```

Auto-stashes dirty changes, checks out each branch, runs the command, restores your branch and stash.
