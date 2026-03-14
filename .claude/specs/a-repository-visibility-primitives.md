# Repository Visibility Primitives Spec

**Issue:** [A] Repository: add findVisibleByUserId, fix findAllByUserId, add updateVisibilityByExternalIds

## Overview

PR #580 leaked a visibility concern into two places it doesn't belong — `findAllByUserId` (now filters) and `publishUpsertedEvent` (runs a second query). This spec restores both to unconditional behaviour and adds two new opt-in primitives so callers that want visibility filtering can ask for it by name.

## Architecture

```
IOpportunityRepository (domain interface)
        |  implements
OpportunityRepository (infrastructure)
        |
        |-- findAllByUserId               -- ALL records, no filter (restored)
        |-- findVisibleByUserId           -- WHERE is_visible=true (new)
        +-- updateVisibilityByExternalIds -- bulk UPDATE by externalId list (new)

SyncGmailEmailsForUserEventHandler
        +-- findVisibleByUserId   (was findAllByUserId)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/backend/src/domain/opportunities/opportunity.repository.interface.ts` | modify | Add `findVisibleByUserId` and `updateVisibilityByExternalIds` signatures |
| `apps/backend/src/infrastructure/database/repositories/opportunity.repository.ts` | modify | Restore `findAllByUserId`; implement new methods; remove `filterVisibleIds`; make `publishUpsertedEvent` unconditional |
| `apps/backend/src/presentation/event-handlers/sync-gmail-emails-for-user.event-handler.ts` | modify | Call `findVisibleByUserId` instead of `findAllByUserId` |

## Interface Changes

```typescript
// Add to IOpportunityRepository:

findVisibleByUserId(userId: string): Promise<Opportunity[]>;

updateVisibilityByExternalIds(
  userId: string,
  externalIds: string[],
  isVisible: boolean,
): Promise<void>;
```

## Implementation Steps

1. **Update `IOpportunityRepository` interface** (`opportunity.repository.interface.ts`)
   - Add `findVisibleByUserId` and `updateVisibilityByExternalIds` signatures

2. **Restore `findAllByUserId`** (`opportunity.repository.ts`)
   - Remove the `eq(opportunities.isVisible, true)` predicate
   - Simplify to `.where(eq(opportunities.userId, userId))`

3. **Implement `findVisibleByUserId`** (`opportunity.repository.ts`)
   - WHERE: `and(eq(opportunities.userId, userId), eq(opportunities.isVisible, true))`
   - Map results through `Opportunity.fromRecord`

4. **Implement `updateVisibilityByExternalIds`** (`opportunity.repository.ts`)
   - Guard: `if (externalIds.length === 0) return;`
   - `db.update(opportunities).set({ isVisible, updatedAt: new Date() }).where(and(eq(opportunities.userId, userId), inArray(opportunities.externalId, externalIds)))`

5. **Fix `publishUpsertedEvent`** (`opportunity.repository.ts`)
   - Remove `filterVisibleIds` call and early return
   - Pass `opportunityIds` directly to event
   - Delete private `filterVisibleIds` method entirely

6. **Update `SyncGmailEmailsForUserEventHandler`** (`sync-gmail-emails-for-user.event-handler.ts`)
   - Change `findAllByUserId(userId)` to `findVisibleByUserId(userId)`
