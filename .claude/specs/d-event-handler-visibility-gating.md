# Event Handler Visibility Gating Spec

**Issue:** [D] Event handlers: visibility gating in handlers, not repository

## Overview

Issue [A] removes `filterVisibleIds` from `publishUpsertedEvent`, making repository event publishing unconditional. `OpportunityUpsertedEventHandler` must now own the visibility gate: look up each opportunity, filter to visible subset, only run activity creation and GenerateStateOfDeal for visible records.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/backend/src/presentation/event-handlers/opportunity-upserted.event-handler.ts` | modify | Inject repo, filter to visible IDs at start of process() |
| `apps/backend/src/presentation/event-handlers/opportunity-upserted.event-handler.spec.ts` | modify | Mock repo, add hidden/mixed visibility test cases |

## Implementation Steps

1. **Inject `IOpportunityRepository`** — add `OPPORTUNITY_REPOSITORY` import, `@Inject` constructor param

2. **Filter to visible IDs at start of `process()`**:
   ```typescript
   const opportunities = await Promise.all(
     opportunityIds.map(id => this.opportunityRepository.findById(id))
   );
   const visibleIds = opportunities
     .filter((opp): opp is Opportunity => opp !== null && opp.isVisible)
     .map(opp => opp.id);
   if (visibleIds.length === 0) return;
   ```

3. **Thread `visibleIds` through remaining logic** — activity DTOs and GenerateStateOfDeal use `visibleIds` instead of `opportunityIds`

4. **Update specs**:
   - Mock `findById` to return visible opportunities in existing tests
   - Add "skips all when all hidden" test
   - Add "processes only visible subset" test
   - Add "handles null (deleted) opportunity gracefully" test
