# Commit 2: Add resolveColumnWidths

## Overview
Add test file for the already-written `resolve-widths.ts` utility. Commit both files.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/src/lib/table/resolve-widths.ts` | commit (exists) | Width distribution algorithm |
| `apps/frontend/src/lib/table/resolve-widths.test.ts` | create | Tests for resolveColumnWidths |

## Implementation Steps
1. Write `resolve-widths.test.ts` — copy from reference branch (`git show dug/7-dt-stories:apps/frontend/src/lib/table/resolve-widths.test.ts`)
2. Run `cd apps/frontend && bunx vitest run src/lib/table/resolve-widths.test.ts`
3. Commit both files: `feat: add resolveColumnWidths utility`
