# Commit 3: Add useDataTableState Hook

## Overview
Port `useDataTableState` hook that encapsulates DataTable's column visibility, sorting, search, and resize state with localStorage persistence.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/src/components/organisms/DataTable/useDataTableState.ts` | create | State management hook |
| `apps/frontend/src/components/organisms/DataTable/useDataTableState.test.ts` | create | Tests |
| `apps/frontend/src/components/organisms/DataTable/DataTable.types.ts` | modify | Add DataTableState + DataTableActions interfaces |
| `apps/frontend/src/components/organisms/DataTable/index.ts` | modify | Export hook + new types |

## Interface

```typescript
interface UseDataTableStateOptions {
  fields: Record<string, FieldMeta>;
  defaultColumns: readonly string[];
  searchFields?: readonly string[];
  storageKey?: string;
}

interface DataTableState {
  searchQuery: string;
  sorting: SortingState;
  visibleColumnIds: string[];
  searchableColumnIds: string[];
  columnIdsForTable: string[];
  columnVisibility: Record<string, boolean>;
  userWidths: Record<string, number>;
}

interface DataTableActions {
  setSearchQuery: (query: string) => void;
  setSorting: (sorting: SortingState) => void;
  setColumnVisibility: (columnId: string, visible: boolean) => void;
  reorderColumns: (fromIndex: number, toIndex: number) => void;
  setColumnWidth: (columnId: string, width: number) => void;
  resetColumnWidth: (columnId: string) => void;
  resetAllColumnWidths: () => void;
}
```

## Implementation Steps
1. Copy `useDataTableState.ts` from reference branch — it matches the plan exactly
2. Copy `useDataTableState.test.ts` from reference branch
3. Add `DataTableState` and `DataTableActions` interfaces to `DataTable.types.ts` (keep existing `CellSaveFn`, `CellEditFactory`, `DataTableProps`, `FieldsPanelColumn`)
4. Update `index.ts` to export `useDataTableState`, `DataTableState`, `DataTableActions`
5. Run tests: `cd apps/frontend && bunx vitest run src/components/organisms/DataTable/useDataTableState.test.ts`
6. Run build: `cd apps/frontend && bun run build`
7. Commit: `feat: add useDataTableState hook`

## Key Notes
- localStorage keys: `datatable:${storageKey}:columns` and `datatable:${storageKey}:widths`
- NO migration code needed — the old format on main is `datatable-${id}-visible-columns` which is managed by DataTable.tsx directly, not by this hook. Migration will happen when DataTable.tsx switches to the hook in Commit 5.
- The hook is exported but NOT yet consumed by DataTable — that happens in Commit 5
