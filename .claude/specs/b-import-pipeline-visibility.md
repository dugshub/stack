# Import Pipeline — Backfill All, Set Visibility by Selection Spec

**Issue:** [B] Import pipeline: backfill all, set visibility by selection

## Overview

`ImportOpportunitiesUseCase` currently imports only the SF opportunities the user explicitly selected. After this change it imports all open opportunities via `BackfillEntityUseCase` default filters (IsClosed=false, CreatedDate>=12mo), then sets visibility in two steps: hide all imported records, then show only the user's selection. The frontend's `externalIds` field already represents the selection — no tRPC, event schema, or frontend changes are needed.

## Architecture

```
ImportOpportunitiesEventHandler
        |  maps externalIds -> selectedExternalIds
        v
ImportOpportunitiesUseCase
        |-- BackfillEntityUseCase (no entityIds -> default filters -> ALL open opps)
        |-- IOpportunityRepository.updateVisibilityByExternalIds (hide all imported)
        |-- IOpportunityRepository.updateVisibilityByExternalIds (show selected)
        |-- importRelatedContacts (unchanged)
        |-- linkOpportunityContacts (unchanged)
        +-- queueProvider.publishEvent(OpportunitiesImportedEvent)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/backend/src/applications/use-cases/import-opportunities.use-case.ts` | modify | Rename input field, remove early-return, inject repo, drop entityIds from backfill, add visibility update |
| `apps/backend/src/applications/use-cases/import-opportunities.use-case.spec.ts` | modify | Update input shapes, remove early-return test, add visibility test |
| `apps/backend/src/presentation/event-handlers/import-opportunities.event-handler.ts` | modify | Pass `selectedExternalIds: externalIds` |

## Interface Changes

```typescript
// Before:
export interface ImportOpportunitiesInput {
  userId: string;
  salesforceOpportunityIds: string[];
}

// After:
export interface ImportOpportunitiesInput {
  userId: string;
  selectedExternalIds: string[];
}
```

New constructor dependency:
```typescript
@Inject(OPPORTUNITY_REPOSITORY)
private readonly opportunityRepository: IOpportunityRepository
```

## Implementation Steps

1. **Rename input field** — `salesforceOpportunityIds` to `selectedExternalIds` in interface and destructuring

2. **Remove empty-array early return** — tRPC schema enforces `min(1)`, use case always proceeds

3. **Inject `IOpportunityRepository`** — add to constructor, imports from `@/constants` and `@/domain`

4. **Remove `entityIds` from backfill call** — BackfillEntityUseCase falls through to `config.defaultFilters`

5. **Compute `failedIds` against selected IDs** — `selectedExternalIds.filter(id => !importedExternalIdSet.has(id))`

6. **Set visibility after backfill** (inside `if (imported.length > 0)`, before contact import):
   - `updateVisibilityByExternalIds(userId, allImportedExternalIds, false)` — hide all
   - `updateVisibilityByExternalIds(userId, selectedExternalIds, true)` — show selected

7. **Update event handler** — change `salesforceOpportunityIds: externalIds` to `selectedExternalIds: externalIds`

8. **Update specs** — rename input key everywhere, add visibility assertion test, remove early-return test
