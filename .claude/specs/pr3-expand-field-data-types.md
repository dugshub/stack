# PR3: Expand FieldDefinitionDataType to Preserve SFDC Type Fidelity

## Overview
Store the rich normalized type (money, percentage, longtext, datetime, email, url) directly in `dataType` instead of collapsing to 6 generic buckets. The frontend already has renderers for all these types.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `packages/db/src/constants.ts` | MODIFY | Add MONEY, PERCENTAGE, LONGTEXT, DATETIME, EMAIL, URL to FieldDefinitionDataType |
| `apps/backend/src/applications/use-cases/import-field-definitions.use-case.ts` | MODIFY | Update mapFieldTypeToDataType to preserve rich types |
| `apps/frontend/src/lib/eav-utils.ts` | MODIFY | Add new types to dataTypeToFieldType map |
| `apps/frontend/src/routes/_authenticated/_shell/admin/entities/-field-control.tsx` | CHECK | Uses FieldDefinitionDataType — may need switch cases updated |
| `apps/frontend/src/routes/_authenticated/_shell/admin/entities/$entityId.tsx` | CHECK | Uses FieldDefinitionDataType — may need switch cases updated |
| `apps/backend/src/domain/field-definitions/field-definition.entity.ts` | CHECK | Uses FieldDefinitionDataType — verify compatibility |
| `apps/backend/src/domain/field-definitions/field-definition.repository.interface.ts` | CHECK | Uses FieldDefinitionDataType — verify compatibility |

## Implementation Steps

### Step 1: Expand FieldDefinitionDataType enum

In `packages/db/src/constants.ts`, add new values:

```ts
export const FieldDefinitionDataType = {
  TEXT: 'text',
  LONGTEXT: 'longtext',
  NUMBER: 'number',
  MONEY: 'money',
  PERCENTAGE: 'percentage',
  DATE: 'date',
  DATETIME: 'datetime',
  BOOLEAN: 'boolean',
  SELECT: 'select',
  REFERENCE: 'reference',
  EMAIL: 'email',
  URL: 'url',
} as const;
```

### Step 2: Update mapFieldTypeToDataType

In `apps/backend/src/applications/use-cases/import-field-definitions.use-case.ts`, update the switch to preserve rich types:

```ts
function mapFieldTypeToDataType(type: string): FieldDefinitionDataType {
  switch (type) {
    case 'money':
      return FieldDefinitionDataType.MONEY;
    case 'number':
      return FieldDefinitionDataType.NUMBER;
    case 'percentage':
      return FieldDefinitionDataType.PERCENTAGE;
    case 'date':
      return FieldDefinitionDataType.DATE;
    case 'datetime':
      return FieldDefinitionDataType.DATETIME;
    case 'boolean':
      return FieldDefinitionDataType.BOOLEAN;
    case 'enum':
      return FieldDefinitionDataType.SELECT;
    case 'reference':
      return FieldDefinitionDataType.REFERENCE;
    case 'email':
      return FieldDefinitionDataType.EMAIL;
    case 'url':
      return FieldDefinitionDataType.URL;
    case 'textarea':
      return FieldDefinitionDataType.LONGTEXT;
    default:
      return FieldDefinitionDataType.TEXT;
  }
}
```

Note: the `selectOptions` check on line ~143 currently checks `dataType === FieldDefinitionDataType.SELECT` — this still works fine.

### Step 3: Update frontend dataTypeToFieldType map

In `apps/frontend/src/lib/eav-utils.ts`:

```ts
export const dataTypeToFieldType: Record<string, FieldType> = {
  text: 'text',
  longtext: 'textarea',
  number: 'number',
  money: 'money',
  percentage: 'percentage',
  date: 'date',
  datetime: 'datetime',
  boolean: 'boolean',
  select: 'enum',
  reference: 'reference',
  email: 'email',
  url: 'url',
};
```

### Step 4: Update resolveFieldValue switch

In `apps/frontend/src/lib/eav-utils.ts`, the `resolveFieldValue` function switches on `fieldDef.dataType`. Currently:
- NUMBER → valueNumber
- DATE → valueDate
- BOOLEAN → valueBoolean
- default → valueText

Update to handle new types that map to existing value columns:
- MONEY, PERCENTAGE → valueNumber (same as NUMBER)
- DATETIME → valueDate (same as DATE)
- LONGTEXT, EMAIL, URL → valueText (same as default)

```ts
export function resolveFieldValue(
  fieldDef: FieldDefinition,
  fieldValue: FieldValue,
): string | number | boolean | Date | null {
  switch (fieldDef.dataType) {
    case FieldDefinitionDataType.NUMBER:
    case FieldDefinitionDataType.MONEY:
    case FieldDefinitionDataType.PERCENTAGE:
      return fieldValue.valueNumber != null
        ? Number(fieldValue.valueNumber)
        : null;
    case FieldDefinitionDataType.DATE:
    case FieldDefinitionDataType.DATETIME:
      return fieldValue.valueDate ?? null;
    case FieldDefinitionDataType.BOOLEAN:
      return fieldValue.valueBoolean ?? null;
    default:
      return fieldValue.valueText ?? null;
  }
}
```

### Step 5: Check all other FieldDefinitionDataType consumers

Read and update if needed:
- `apps/frontend/src/routes/_authenticated/_shell/admin/entities/-field-control.tsx`
- `apps/frontend/src/routes/_authenticated/_shell/admin/entities/$entityId.tsx`
- `apps/backend/src/domain/field-definitions/field-definition.entity.ts`
- `apps/backend/src/domain/field-definitions/field-definition.repository.interface.ts`
- Any test files that reference FieldDefinitionDataType

### Step 6: Data backfill

Existing field_definitions rows have collapsed types. Users need to re-import their field definitions to pick up the richer types. No SQL migration needed — the column is varchar(20) and accepts any string. A re-import triggers `describe()` → `normalizeFieldType()` → `mapFieldTypeToDataType()` which will now store the rich types.

Note: do NOT write a SQL migration that guesses types. The correct types come from SFDC describe — let the importer do its job.

## No schema migration needed
The `data_type` column is `varchar(20)` — it already accepts any string value. We're just storing more specific strings.
