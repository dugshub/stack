# stack

A CLI for stacked PRs. No accounts, no hosted service — just `git` and `gh`.

## Install

```bash
bun install -g git+ssh://git@github.com/dugshub/stack.git
```

Requires [Bun](https://bun.sh) and the [GitHub CLI](https://cli.github.com) (`gh auth login`).

## Quick start

```bash
stack create my-feature                          # start a stack

git checkout -b dug/my-feature/1-add-schema      # branch for PR 1
# ... work, commit ...
stack push                                       # add to stack

git checkout -b dug/my-feature/2-add-api         # branch for PR 2
# ... work, commit ...
stack push                                       # add to stack

stack submit                                     # push + create PRs
```

That's it. Each PR targets the branch below it, so reviewers see clean incremental diffs. A navigation comment is posted on every PR:

| # | Branch | PR | Status |
|---|--------|-----|--------|
| **1** | **dug/my-feature/1-add-schema** | **#101** | **Review** |
| 2 | dug/my-feature/2-add-api | #102 | Draft |

## Commands

```
stack status                  Show stack and PR status
stack create [name]           Start a new stack
stack push                    Add current branch to the stack
stack submit                  Push all branches, create/update PRs
stack submit --dry-run        Preview without making changes
stack nav up|down|top|bottom  Move between branches
stack restack                 Rebase downstream after mid-stack edits
stack sync                    Clean up after PRs merge
stack update                  Self-update
```

## Day-to-day workflow

**Editing mid-stack?** Amend your commit, then `stack restack` to cascade the change through all downstream branches.

**PR merged?** Run `stack sync`. It removes merged branches, retargets downstream PRs, and rebases the rest onto trunk.

**Conflicts during restack?** Resolve them normally, stage the files, then `stack restack --continue`.

## Branch naming

Use this convention and PR titles are derived automatically:

```
<you>/<stack-name>/<n>-<description>
```

`dug/my-feature/1-add-schema` → PR title **"Add Schema"**

## Claude Code

If you use [Claude Code](https://claude.ai/code), run `stack init` in your project to install stack-aware skills. Claude will see your stack context and can navigate, submit, and restack as part of larger workflows.

## Updating

```bash
stack update
```
