# PR2: Kill fields.tsx — Use FieldDefinition as Metadata Source

## Overview
Delete the static `opportunitiesTableFields` config in `fields.tsx` and make `buildEntityFields()` the sole source of field metadata. No overrides table — all static-only properties are being removed.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/src/features/opportunities/fields.tsx` | DELETE | Remove static field config |
| `apps/frontend/src/features/opportunities/index.ts` | MODIFY | Inline `defaultColumns` + `searchFields`, drop fields.tsx re-exports |
| `apps/frontend/src/hooks/useOpportunities.ts` | MODIFY | Remove static overrides, export `OpportunityWithFields` type |
| `apps/frontend/src/lib/eav-utils.ts` | MODIFY | Remove `overrides` param from `buildEntityFields()` |
| `apps/frontend/src/lib/types/field-meta.ts` | MODIFY | Remove dead properties from `FieldMeta` interface |
| `apps/frontend/src/features/opportunities/pages/OpportunityOverview/FieldsTab.tsx` | MODIFY | Remove static type lookup |
| `apps/frontend/src/routes/_authenticated/_shell/dashboard/opportunities/index.tsx` | MODIFY | Update imports |
| `apps/frontend/src/routes/_authenticated/_shell/admin/entities/index.tsx` | MODIFY | Update imports |
| `apps/frontend/src/features/opportunity-detail/components/OpportunityHeader.tsx` | MODIFY | Update import |
| `apps/frontend/src/components/organisms/DataTable/DataTable.tsx` | MODIFY | Remove `visible !== false` filter |

## Implementation Steps

### Step 1: Strip dead properties from FieldMeta (`field-meta.ts`)

Remove from `FieldMeta` interface:
- `importance?: FieldImportance` (line 89)
- `compactThreshold?: number` (line 107)
- `visible?: boolean` (line 113)
- `reference?: string` (line 134)

Remove `FieldImportance` type (line 53) and its JSDoc block (lines 47-53).

Remove `compactRenderer` (line 105) — it's part of the compact layout system being removed.

Keep: `width`, `sortable`, `editable`, `filterable`, `cellRenderer`, `format`, `icon`, `dateSubtype`, `showAvatar`, `source`, `group`, `placeholder`, `help`, `choices`.

### Step 2: Drop overrides from `buildEntityFields()` (`eav-utils.ts`)

Change signature from:
```ts
export function buildEntityFields(
  fieldDefinitions: FieldDefinition[],
  overrides?: Record<string, Partial<FieldMeta>>,
): Record<string, FieldMeta>
```

To:
```ts
export function buildEntityFields(
  fieldDefinitions: FieldDefinition[],
): Record<string, FieldMeta>
```

Remove `...overrides?.[def.key]` spread (line 91).
Remove `importance: 'secondary'` from the field construction (line 88) — importance is being removed.

### Step 3: Rewire `useOpportunities.ts`

1. Move `OpportunityWithFields` interface INTO this file (it's already defined in fields.tsx, just move it). Export it.
2. Remove imports from `@/features/opportunities/fields`
3. `buildOpportunityFields()`: call `buildEntityFields(uniqueDefs)` with no second argument
4. `useOpportunity` keyFields (line 127-130): change from:
   ```ts
   fieldType:
     opportunitiesTableFields[fieldDefinition.key]?.type ??
     dataTypeToFieldType[fieldDefinition.dataType] ??
     'text',
   ```
   To:
   ```ts
   fieldType: (dataTypeToFieldType[fieldDefinition.dataType] ?? 'text') as FieldType,
   ```

### Step 4: Fix FieldsTab.tsx

1. Remove `import { opportunitiesTableFields } from '@/features/opportunities/fields'`
2. Change line 38-40 from:
   ```ts
   fieldType: (opportunitiesTableFields[fd.key]?.type ??
     dataTypeToFieldType[fd.dataType] ??
     'text') as FieldType,
   ```
   To:
   ```ts
   fieldType: (dataTypeToFieldType[fd.dataType] ?? 'text') as FieldType,
   ```

### Step 5: Update barrel + re-home consts (`features/opportunities/index.ts`)

Replace the file contents with:
```ts
/**
 * Opportunity entity module.
 * Central place for opportunity-related types and config.
 */

// Type from DB schema
export type { Opportunity } from '@repo/db/schema/client';

// Default visible columns for opportunity tables
export const defaultColumns = [
  'Name',
  'StageName',
  'Amount',
  'Probability',
  'NextStep',
  'CloseDate',
  'updatedAt',
];

// Fields to include in search
export const searchFields = ['Name', 'NextStep'];

// Pages
export { OpportunityDetailPage } from './pages/OpportunityOverview';
```

### Step 6: Update route imports

**`routes/.../opportunities/index.tsx`:**
- Change `import { defaultColumns, type OpportunityWithFields } from '@/features/opportunities/fields'` → import `defaultColumns` from `@/features/opportunities` and `OpportunityWithFields` from `@/hooks/useOpportunities`
- Keep `import { searchFields } from '@/features/opportunities'` as-is

**`routes/.../admin/entities/index.tsx`:**
- Change `import type { OpportunityWithFields } from '@/features/opportunities/fields'` → `import type { OpportunityWithFields } from '@/hooks/useOpportunities'`
- Keep `import { defaultColumns, searchFields } from '@/features/opportunities'` as-is

**`OpportunityHeader.tsx`:**
- Change `import type { OpportunityWithFields } from '@/features/opportunities/fields'` → `import type { OpportunityWithFields } from '@/hooks/useOpportunities'`

### Step 7: Remove `visible` filter from DataTable (`DataTable.tsx`)

Line 665: `.filter(([_, field]) => field.visible !== false)` — remove this filter. After fields.tsx deletion, structural columns (id, externalId) won't be in the field map so the filter is unnecessary.

### Step 8: Delete `fields.tsx`

Delete `apps/frontend/src/features/opportunities/fields.tsx`.

### Step 9: Clean up remaining references

Check for any remaining `FieldImportance` imports/usages. Remove the import from the barrel in `@/lib/types` if exported there. Check `@/types/field-meta.ts` shim for any references to removed properties.

## Accepted Regressions
- Amount renders as `number` (not `money`) until PR3
- Probability renders as `number` (not `percentage`) until PR3
- Description/NextStep render as `text` (not `textarea`) until PR3
- StageName renders as `text` (not `enum` — it maps to SELECT which maps to enum, so this may actually be correct)
