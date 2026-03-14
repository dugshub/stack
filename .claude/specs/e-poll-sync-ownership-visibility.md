# Poll Sync — Set is_visible on CREATE by Ownership Spec

**Issue:** [E] Poll sync: set is_visible on CREATE by ownership

## Overview

The 5-minute poll sync inserts new records for any SF opportunity modified org-wide. These records land with `is_visible=true` (schema default) and trigger LLM work. This change adds an ownership check: on CREATE of an opportunity, if `OwnerId` does not match `integration.providerUserId`, the record is hidden. UPDATEs and non-opportunity entities are untouched.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/backend/src/applications/use-cases/sync/inbound/process-inbound-change.use-case.ts` | modify | Inject repos, add ownership check on CREATE |
| `apps/backend/src/applications/use-cases/sync/inbound/process-inbound-change.use-case.spec.ts` | modify | Add owner match/mismatch/UPDATE/non-opportunity test cases |

## Implementation Steps

1. **Inject `IIntegrationRepository` and `IOpportunityRepository`** — add to constructor

2. **Add ownership check after upsert** (inside try block, non-DELETE branch only):
   ```typescript
   if (
     body.changeType === SyncChangeType.CREATE &&
     body.entityType === SyncEntityType.Opportunity
   ) {
     const integration = await this.integrationRepository.findById(body.integrationId);
     const ownerId = body.recordData['OwnerId'];
     if (integration && typeof ownerId === 'string' && ownerId !== integration.providerUserId) {
       await this.opportunityRepository.updateVisibilityByExternalIds(
         body.userId,
         [body.externalId],
         false,
       );
     }
     // TODO: detect OwnerId change on UPDATE and flip visibility (future enhancement)
   }
   ```

3. **Handle integration not found** — skip visibility update, log warning

4. **Update specs**:
   - Add "CREATE opportunity owned by user — no visibility change" test
   - Add "CREATE opportunity owned by another user — hides record" test
   - Add "UPDATE opportunity — no visibility change" test
   - Add "CREATE non-opportunity entity — no visibility change" test
   - Add "CREATE opportunity, integration not found — no throw" test
