# Electric Shapes Visibility Filter Spec

**Issue:** [C] Electric shapes: filter by is_visible=true

## Overview

Three Electric shape definitions stream all of a user's opportunities to the client regardless of visibility. Adding `AND "is_visible" = true` to each relevant WHERE clause ensures only visible opportunities (and their dependent update/fact rows) are synced. Independent of other issues.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/backend/src/infrastructure/electric/shape-definitions.ts` | modify | Add `is_visible=true` filter to three shape WHERE clauses |

## WHERE Clause Changes

### 1. `opportunities`
Before: `"user_id" = $1`
After: `"user_id" = $1 AND "is_visible" = true`

### 2. `opportunity-updates`
Before: `opportunity_id IN (SELECT id FROM opportunities WHERE "user_id" = $1)`
After: `opportunity_id IN (SELECT id FROM opportunities WHERE "user_id" = $1 AND "is_visible" = true)`

### 3. `opportunity-update-facts`
Before: `"opportunity_update_id" IN (SELECT id FROM opportunity_updates WHERE opportunity_id IN (SELECT id FROM opportunities WHERE "user_id" = $1))`
After: `"opportunity_update_id" IN (SELECT id FROM opportunity_updates WHERE opportunity_id IN (SELECT id FROM opportunities WHERE "user_id" = $1 AND "is_visible" = true))`

Only the innermost subquery (on `opportunities`) is modified in each case.
