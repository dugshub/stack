# Legacy Salesforce Adapter Cleanup Spec

**Issue:** [F] Remove legacy Salesforce adapter methods

## Overview

Remove two obsolete methods from `SalesforceAdapter` — `getOpenOpportunities()` and `getOpportunitiesByIds()` — which have zero production callers. Both were superseded by the generic `readMany()` port. Associated types and spec cases are also removed. Independent of other issues.

## Verification: No Live Callers

- `getOpenOpportunities` — one match: its own definition. No callers.
- `getOpportunitiesByIds` — matches only in definition and spec. No production callers.
- `SalesforceOpportunity` — used in deleted methods AND `getOrganizationName()` line 151 (must inline before deleting)
- `SalesforceOpportunityDetails` — only used in `getOpportunitiesByIds`. Safe to delete.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/backend/src/infrastructure/adapters/salesforce/salesforce.adapter.ts` | modify | Delete two methods, fix residual type, clean imports |
| `apps/backend/src/infrastructure/adapters/salesforce/salesforce.types.ts` | modify | Delete `SalesforceOpportunity` and `SalesforceOpportunityDetails` |
| `apps/backend/src/infrastructure/adapters/salesforce/salesforce.adapter.spec.ts` | modify | Delete `describe('getOpportunitiesByIds')` block |

## Implementation Steps

1. **Fix residual type in `getOrganizationName()`** (line 151)
   - Replace `Pick<SalesforceOpportunity, 'Name'>` with `{ Name: string }`

2. **Remove imports** from adapter
   - Remove `SalesforceOpportunity` and `SalesforceOpportunityDetails` from `./salesforce.types` import
   - Retain `SalesforceField`, `SalesforceUserInfo`, `SalesforceUserInfoResult`

3. **Delete `getOpenOpportunities()`** (lines 164-196)

4. **Delete `getOpportunitiesByIds()`** (lines 198-245)

5. **Delete type interfaces** from `salesforce.types.ts`
   - `SalesforceOpportunity` (lines 28-33)
   - `SalesforceOpportunityDetails` (lines 55-66)

6. **Delete spec block** from `salesforce.adapter.spec.ts`
   - `describe('getOpportunitiesByIds')` block (lines 215-303)
