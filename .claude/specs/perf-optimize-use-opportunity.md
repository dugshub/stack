# Perf: Optimize useOpportunity — Filter Before Aggregate

**Branch:** `perf/optimize-use-opportunity`

## Overview

`useOpportunity(id)` calls `aggregateOpportunities(data)` on the full join dataset (all opportunities × all field values), builds a `Map`, converts to an array, then discards all but one via `.find()`. The fix filters raw rows to the target `id` first, then accumulates onto a single object — no Map, no array, no `.find()`. Reduces processed rows from ~1,089 to ~9 on the detail page.

## Architecture

```
useOpportunity(id)
  BEFORE:
    aggregateOpportunities(ALL rows) → Map → Array → .find(id)

  AFTER:
    data.filter(row => row.opportunity.id === id)  ← pre-filter
    aggregateSingleOpportunity(rows)               ← new helper, no Map needed
```

Model pattern: `useOpportunityFields` (lines 155-164) and `keyFieldDefs` (lines 123-140) already filter by id first.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/src/hooks/useOpportunities.ts` | modify | Add `aggregateSingleOpportunity`, rewrite `useOpportunity` memo |
| `apps/frontend/src/hooks/useRenderPerf.ts` | create | Perf measurement hook |
| `apps/frontend/src/hooks/index.ts` | modify | Barrel export for `useRenderPerf` |
| `apps/frontend/src/routes/_authenticated/_shell/dashboard/opportunities/index.tsx` | modify | Add `useRenderPerf` call |

## Interface

```typescript
// New helper — module-private, not exported
// Precondition: all rows have the same opportunity.id, rows is non-empty
function aggregateSingleOpportunity(rows: typeof data): OpportunityWithFields
```

```typescript
// useOpportunity memo — BEFORE (lines 117-121):
const opportunity = useMemo(() => {
  if (!id || !data) return undefined;
  const aggregated = aggregateOpportunities(data);
  return aggregated.find((opp) => opp.id === id);
}, [id, data]);

// AFTER:
const opportunity = useMemo(() => {
  if (!id || !data) return undefined;
  const rows = data.filter((r) => r.opportunity.id === id);
  if (rows.length === 0) return undefined;
  return aggregateSingleOpportunity(rows);
}, [id, data]);
```

## Implementation Steps

### 1. Create `useRenderPerf` hook (`hooks/useRenderPerf.ts`)
Same as other branches — see `perf-row-virtualization.md` spec for details.

### 2. Export from barrel (`hooks/index.ts`)
```typescript
export { useRenderPerf } from './useRenderPerf'
```

### 3. Add `aggregateSingleOpportunity` helper (`useOpportunities.ts`)
Place directly below `aggregateOpportunities` (after ~line 72).

Pseudocode:
```
function aggregateSingleOpportunity(rows):
  first = rows[0]
  result = {
    id, externalId, createdAt, updatedAt,
    providerMetadata, userId, stateOfDeal
  } from first.opportunity

  for each { fieldDefinition, fieldValue, account } in rows:
    result[fieldDefinition.key] = resolveFieldValue(fieldDefinition, fieldValue)
    if account:
      result.AccountName = account.name

  return result
```

Mirror the field-resolution logic from `aggregateOpportunities` (lines 55-68) but without a Map — just accumulate on one object.

### 4. Rewrite `useOpportunity` memo (lines 117-121)
Replace:
```typescript
const aggregated = aggregateOpportunities(data);
return aggregated.find((opp) => opp.id === id);
```
With:
```typescript
const rows = data.filter((r) => r.opportunity.id === id);
if (rows.length === 0) return undefined;
return aggregateSingleOpportunity(rows);
```

`aggregateOpportunities` remains used by `useOpportunities` (line 93) — do not remove it.

### 5. Instrument `OpportunitiesIndexPage`
- Import `useRenderPerf` from `@/hooks`
- Call `useRenderPerf('OpportunitiesPage')` inside the component

## Open Questions

- Should `aggregateSingleOpportunity` be exported for potential reuse in other single-entity hooks?
- Could `keyFieldDefs` memo (lines 123-140) reuse the pre-filtered `rows` from the `opportunity` memo to avoid a second pass? Out of scope but worth noting.
