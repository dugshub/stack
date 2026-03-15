# Status Checks in `stack status`

## Goal
Show CI check status alongside review status in `stack status` output.

## Scope
3 files, ~30 lines of changes. No refactoring — extending existing patterns.

## Changes

### 1. `src/lib/types.ts` — Add checks field to `PrStatus`
Add optional `checksStatus` field:
```ts
checksStatus?: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'EXPECTED' | 'ERROR' | null;
```
Note: `EXPECTED` maps to pending display (checks configured but not yet triggered).

### 2. `src/lib/gh.ts` — Add `statusCheckRollup` to GraphQL query
In `prViewBatch()`, add to the GraphQL fields:
```graphql
commits(last: 1) {
  nodes {
    commit {
      statusCheckRollup {
        state
      }
    }
  }
}
```
Parse the nested result into the flat `checksStatus` field when building `PrStatus` objects.

### 3. `src/lib/ui.ts` — Display checks in table
- Add a `checksEmoji()` helper: ✅ SUCCESS, ❌ FAILURE, 🔄 PENDING, ⬜ null
- Add a `Checks` column to the `stackTree` table header
- Render the checks emoji in each row

### 4. `src/commands/status.ts` — Include in JSON output
The `checksStatus` field will automatically appear in JSON output since it's part of `PrStatus`.
No changes needed — `prStatus` is already spread into the JSON output.

## Non-goals
- Detailed per-check breakdown (just rollup state)
- Checks for branches without PRs
