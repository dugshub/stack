# GraphQL Batch Submit — Unit of Work Pattern

## Problem

`stack submit` with N branches makes ~5N sequential shell spawns hitting the GitHub API:

| Phase | Calls per branch | Total (7 branches) |
|-------|----------------:|--------------------:|
| `git push` (always, even if no-op) | 1 | 7 |
| `gh pr view` (verify existing PR) | 1 | 7 |
| `gh pr edit` (update base) | 1 | 7 |
| `gh pr view` (fetch statuses for comments) | 1 | 7 |
| `gh pr comment` (post stack table) | 1 | 7 |
| **Total** | **5** | **~35** |

Each `gh` call has ~500-800ms of network latency. A 7-branch submit takes 15-25 seconds.

## Solution

A **unit-of-work pattern** where GitHub operations are collected into batches and flushed as minimal GraphQL API calls. Combined with push-skipping for unchanged branches.

**After optimization (7 branches, all existing PRs, nothing changed):**

| Phase | Calls |
|-------|------:|
| `git push` (only changed branches) | 0-7 |
| Batch read (one GraphQL query) | 1 |
| Batch mutate: creates + base updates (one GraphQL mutation) | 0-1 |
| Batch mutate: comments (one GraphQL mutation) | 0-1 |
| **Total** | **1-10** |

Best case (all up-to-date, no base changes, comments identical): **1 API call, 0 pushes**.

## Architecture

### New file: `src/lib/graphql.ts`

Two exports:

#### 1. `fetchPRDetails(owner, repo, prNumbers)` — Batch Read

Single GraphQL query that returns everything submit needs:

```typescript
interface PRDetails {
  number: number;
  nodeId: string;           // for mutations
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  reviewDecision: string;
  baseRefName: string;      // current base branch — for skip-if-unchanged
  botComment: {             // last comment by us with stack marker — for skip-if-identical
    nodeId: string;
    body: string;
  } | null;
}

interface BatchReadResult {
  repoNodeId: string;       // needed for createPullRequest mutation
  viewerLogin: string;      // needed to identify our comments
  prs: Map<number, PRDetails>;
}

export function fetchPRDetails(
  owner: string,
  repo: string,
  prNumbers: number[],
): BatchReadResult;
```

**GraphQL query shape:**

```graphql
query {
  viewer { login }
  repository(owner: "owner", name: "repo") {
    id
    pr_1: pullRequest(number: 1) {
      id
      number
      title
      state
      isDraft
      url
      reviewDecision
      baseRefName
      comments(last: 30) {
        nodes {
          id
          body
          author { login }
        }
      }
    }
    # ... more aliases
  }
}
```

**Bot comment detection:** Filter `comments.nodes` by:
1. `author.login === viewerLogin`
2. `body.includes('### PR Stack')` (the marker from `comment.ts`)

Take the **last** matching comment (most recent). This replicates `gh pr comment --edit-last` behavior.

**Edge cases:**
- If `prNumbers` is empty (first submit), the query still runs to fetch `repoNodeId` and `viewerLogin`. The query is valid with zero PR aliases.
- If GraphQL call fails entirely, throw an error (fail fast — no silent degradation).
- PRs that don't resolve (deleted) simply won't appear in the map.
- `comments(last: 30)` is enough — the bot comment is usually the last one or close to it.
- GraphQL field `id` maps to `nodeId` in the `PRDetails` interface (and `botComment.nodeId`). The implementer must rename this field when parsing results.

**Behavioral note:** The current `gh pr comment --edit-last` edits the last comment by the authenticated user. The new approach filters by `author.login === viewerLogin` AND the `### PR Stack` marker. This is stricter and more correct — it won't accidentally overwrite a non-stack comment by the same user.

#### 2. `MutationBatch` — Composable Write Batching

```typescript
export class MutationBatch {
  constructor(private repoNodeId: string);

  createPR(alias: string, opts: {
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
  }): this;

  updatePRBase(alias: string, prNodeId: string, base: string): this;

  addComment(alias: string, subjectNodeId: string, body: string): this;

  updateComment(alias: string, commentNodeId: string, body: string): this;

  get size(): number;
  get isEmpty(): boolean;

  flush(): MutationResult;
}

interface MutationResult {
  data: Record<string, any>;
  errors: Array<{ message: string; path?: string[] }>;
}
```

**How `flush()` works:**

Constructs a single GraphQL mutation string from all enqueued operations:

```graphql
mutation {
  create_0: createPullRequest(input: {
    repositoryId: "repo_node_id"
    baseRefName: "main"
    headRefName: "user/stack/1-feat"
    title: "Feat"
    body: ""
    draft: true
  }) {
    pullRequest { id number url }
  }
  update_1: updatePullRequest(input: {
    pullRequestId: "PR_kwDO..."
    baseRefName: "user/stack/1-feat"
  }) {
    pullRequest { id number }
  }
  comment_2: addComment(input: {
    subjectId: "PR_kwDO..."
    body: "### PR Stack\n..."
  }) {
    commentEdge { node { id } }
  }
  edit_comment_3: updateIssueComment(input: {
    id: "IC_kwDO..."
    body: "### PR Stack\n..."
  }) {
    issueComment { id }
  }
}
```

Executes via `gh api graphql -f query=<mutation>`.

**After flush:** Callers inspect `MutationResult.data` using the aliases they provided. Each phase creates a fresh `MutationBatch` instance — no reuse.

**Error handling:** GitHub GraphQL returns partial results — some aliases succeed while others fail. `MutationResult.errors` contains the failures with paths. Behavior per phase:
- **Phase 3 (creates):** If a create alias fails, log a `ui.error` for that branch, set `branch.pr = null` (unchanged), and continue. That branch will have no comment posted in Phase 5. Do NOT return early — other creates may have succeeded.
- **Phase 5 (updates + comments):** If an update or comment alias fails, log a `ui.warn` and continue. These are non-fatal.

**String escaping:** Comment bodies contain markdown with quotes, newlines, pipes. The `flush()` method must JSON-escape string values in the GraphQL query (use `JSON.stringify()` for string literals inside the query template). This is critical — unescaped newlines or quotes will break the query.

### Modified file: `src/lib/git.ts`

Add one helper:

```typescript
/** Returns true if the branch needs to be pushed (local tip differs from remote tip). */
export function needsPush(branch: string): boolean {
  const localTip = tryRun('rev-parse', branch);
  if (!localTip.ok) return true; // can't resolve = needs push
  const remoteTip = tryRun('rev-parse', `origin/${branch}`);
  if (!remoteTip.ok) return true; // no remote ref = new branch, needs push
  return localTip.stdout !== remoteTip.stdout;
}
```

### Modified file: `src/commands/submit.ts`

Rewrite `fullSubmit()` to use the batched approach. The dry-run path is unchanged.

**New flow:**

```
Phase 1: Push (only changed branches)
  for each branch:
    if git.needsPush(branch.name):
      push (force-with-lease or push-new, same as today)
      update branch.tip
    else:
      report "up to date, skipped"

Phase 2: Batch Read (one GraphQL call)
  Parse owner/repo from state.repo (format: "owner/repo") — split on '/'
  prNumbers = branches with existing PRs
  { repoNodeId, viewerLogin, prs } = fetchPRDetails(owner, repo, prNumbers)
  NOTE: Always call even if prNumbers is empty — we need repoNodeId for creates

Phase 3: Create new PRs (one mutation)
  createBatch = new MutationBatch(repoNodeId)
  for each branch without a PR:
    createBatch.createPR(alias, { base, head, title, body: '', draft: true })
  if !createBatch.isEmpty:
    result = createBatch.flush()
    for each created PR in result:
      update branch.pr with new PR number
      store nodeId for comment phase

Phase 4: Compute skip decisions
  Build prStatuses map for comment generation:
    - existing PRs: map PRDetails → PrStatus (pick number, title, state, isDraft, url, reviewDecision)
    - new PRs: construct PrStatus with known defaults:
        { number: N, title: <submitted title>, state: 'OPEN', isDraft: true, url: <from create result>, reviewDecision: '' }

  For each branch with a PR:
    desired base = previous branch name (or trunk for first)
    if existing PR and existing.baseRefName === desired base:
      skip base update

    generated comment = generateComment(stack, branch.pr, prStatuses, repoUrl)
    if existing PR and existing.botComment?.body === generated comment:
      skip comment update

Phase 5: Execute updates + comments (one mutation)
  updateBatch = new MutationBatch(repoNodeId)
  for each branch needing base update:
    updateBatch.updatePRBase(alias, prNodeId, desiredBase)
  for each branch needing comment create:
    updateBatch.addComment(alias, prNodeId, comment)
  for each branch needing comment update:
    updateBatch.updateComment(alias, commentNodeId, comment)
  if !updateBatch.isEmpty:
    updateBatch.flush()

Phase 6: Save state, restore branch, report
  stack.updated = new Date().toISOString()
  saveState(state)
  git.checkout(originalBranch) — restore user's branch (try/catch, same as today)
  Print summary (same as today)
```

**Key behavior changes:**
- Skipped pushes show `"↑ branch-name (up to date)"` instead of `"✓ Pushed branch-name"`
- Skipped base updates show `"↑ #123 base unchanged"` instead of always showing update
- Skipped comments are silent (no output line)
- New creates show same message as today

### Modified file: `src/lib/types.ts`

No changes needed. `PrStatus` is sufficient for the comment generation. The `PRDetails` type lives in `graphql.ts` and is internal to the submit flow.

## Implementation Order

1. **`src/lib/git.ts`** — Add `needsPush()`. Zero risk, additive.
2. **`src/lib/graphql.ts`** — New file with `fetchPRDetails` and `MutationBatch`. Self-contained, no existing code changes.
3. **`src/commands/submit.ts`** — Rewrite `fullSubmit()` to use new primitives. This is the only "risky" change.

## Not In Scope

- Changing `status.ts` — it already uses `prViewBatch` and is fast enough.
- Changing `sync.ts` — different access pattern, can adopt later.
- Removing existing `gh.ts` functions — they're still used by other commands.
- Async/parallel git pushes — git pushes are sequential by nature (force-with-lease ordering matters for stacks).
- Fallback to individual `gh` calls if GraphQL fails — keep it simple, fail fast with a clear error.

## Verification

```bash
# Dry run should be unchanged
stack submit --dry-run

# Full submit with existing stack — watch for reduced API calls
stack submit

# Verify: PRs have correct bases, stack comments are posted
stack status

# Edge case: first submit (all new PRs)
# Edge case: re-submit with no changes (should skip everything)
# Edge case: mid-stack base change after restack
```

## Future Extensions

- `MutationBatch` can be reused by `sync.ts` to batch-close PRs.
- `fetchPRDetails` can be extended to fetch CI status, labels, etc.
- If stacks exceed ~50 branches, split the GraphQL query to avoid complexity limits (not a real concern today).
