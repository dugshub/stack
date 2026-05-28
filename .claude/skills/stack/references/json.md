# `st status --json` schema

`st status --json` writes JSON to **stdout** (logs go to stderr). It has **two shapes** depending on whether the command resolves to a single stack.

## Shape A — a single active stack

Emitted when you're on a stack branch, or `--stack <name>` resolves one stack.

```jsonc
{
  "stackName": "my-feature",
  "position": 1,          // 0-based index of the CURRENT branch in branches[]; null if not on a branch in this stack
  "total": 3,             // number of branches
  "trunk": "main",        // base branch the stack is rooted on
  "branches": [
    {
      "name": "user/my-feature/1-add-schema",
      "tip": "<sha>",            // branch HEAD sha (or null)
      "pr": 1234,                // PR number, or null if not yet submitted
      "parentTip": "<sha>",      // parent's tip when this branch was last rebased (drives restack)
      "parentTips": { },         // diamond join branches only: { parentBranchName: sha }
      "joinMergeSha": "<sha>",   // diamond join branches only: the merge commit sha
      "position": 1,             // 1-based position (note: differs from top-level `position`, which is 0-based)
      "isCurrent": true,         // is this the checked-out branch
      "prStatus": {              // null when pr is null or status is uncached
        "number": 1234,
        "title": "Add schema",
        "state": "OPEN",         // OPEN | CLOSED | MERGED
        "isDraft": true,
        "url": "https://github.com/owner/repo/pull/1234",
        "reviewDecision": "",    // e.g. APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, "" 
        "checksStatus": "PENDING" // SUCCESS | FAILURE | PENDING | EXPECTED | ERROR | null
      }
    }
  ],
  "restackState": null,   // non-null object while a restack is paused (see below)
  "dependsOn": [          // present ONLY for dependent/diamond stacks
    { "stack": "base-stack", "branch": "user/base-stack/3-final" }
  ]
}
```

Notes:
- `position` (top-level) is **0-based**; each branch's own `position` field is **1-based**. Report to humans as `position + 1 of total`.
- `prStatus` is the live PR/CI state; `pr` is just the number. To summarize CI: count branches where `prStatus.checksStatus === "SUCCESS"`.
- `restackState` non-null ⇒ a restack is paused (conflict). It carries `fromIndex`, `currentIndex`, and — for diamonds — `joinState.phase` (`"merging"` | `"replaying"`). Tell the user to resolve and run `st continue`.

## Shape B — all tracked stacks

Emitted when the command can't resolve to one stack (e.g. run off any stack branch with no `--stack`). An **array**:

```jsonc
[
  {
    "name": "my-feature",
    "branchCount": 3,
    "trunk": "main",
    "dependsOn": [ { "stack": "...", "branch": "..." } ],  // only if set
    "updated": "2026-03-18T20:31:21.360Z",                 // ISO timestamp
    "restackInProgress": true
  }
]
```

An empty array `[]` means no stacks are tracked in this repo.

## Telling the shapes apart

Parse stdout as JSON: an **object** with a `stackName` key is Shape A; an **array** is Shape B. Branch into your reporting logic accordingly.
