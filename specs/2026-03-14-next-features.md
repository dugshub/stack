# Next Features — Requirements Draft

## 1. New Mutations

### `stack delete [name]`
- Remove a stack from state tracking
- `--branches` — also delete git branches (local + remote)
- `--prs` — also close open PRs
- Default (no flags): remove tracking only, leave branches/PRs intact
- Safety: prompt for confirmation if stack has open PRs
- If no name given and on a stack branch, use active stack

### `stack remove [branch]`
- Remove a single branch from the active stack
- Default: current branch if no arg
- Automatically relinks: removing branch 2 of 4 makes branch 3's parent become branch 1
- Retargets downstream PR's base via `gh pr edit --base`
- `--branch` — also delete the git branch
- `--pr` — also close the PR
- Cannot remove if restack is in progress

### `stack move up|down`
- Shift current branch's position in the stack
- `move up` = toward trunk (swap with branch below)
- `move down` = away from trunk (swap with branch above)
- After move: warn that `stack restack` is needed to rebase the chain
- Or: auto-restack after move?

## 2. Interactive Nav

### `stack nav` (no args) → interactive TUI
- Show stack as a selectable list using `@clack/prompts` select
- Highlight current branch with position marker
- Show PR number and status for each branch
- Arrow keys to move, enter to checkout, q/esc to cancel
- `stack nav up|down|top|bottom` stays instant (no TUI)

## 3. Grouped Help Output

### Bare `stack` output organized into sections:
```
Stack
  create, delete, status

Branches
  push, remove, move, nav

Workflow
  submit, restack, sync

Meta
  init, update
```

## 4. Future: Stack Topology (branch/fork)

### `stack branch [name]` — Split a stack
- At current position, split the stack into two
- Branches above become a new stack, inheriting the current branch as their trunk
- Original stack ends at current branch
- Use case: "these top 3 PRs are actually a separate feature"

### `stack fork [name]` — Create parallel stack from mid-stack
- Create a new stack that branches off from the current branch
- The new stack shares a common ancestor with the original
- Like git branching but for stacks — models diamond dependencies
- Use case: "I need two parallel features that both depend on PR #2"

### Topology model
- Currently: stacks are linear arrays of branches
- Future: stacks could reference a parent stack + branch index
- This models issue dependency graphs:
  - Linear: A → B → C (current)
  - Split: A → B → C, then B becomes trunk for D → E (branch)
  - Diamond: A → B → C and A → B → D, both depend on B (fork)
- State change: `Stack.parent?: { stack: string, branchIndex: number }`
- Submit would need to understand cross-stack dependencies
- Sync would need to cascade across dependent stacks

### Open questions
- Should `stack status` show the full topology tree?
- Should `stack sync` cascade across forked stacks?
- How does submit order work across dependent stacks?
- Is the mental model "stacks of stacks" or "branch graph"?

## Priority Order
1. `delete` + `remove` (table stakes, needed now)
2. Interactive nav (quick win, big UX improvement)
3. Grouped help output (polish)
4. `move` (nice to have)
5. `branch` / `fork` (future architecture)
