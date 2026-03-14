# Commit 5: Wire Everything into DataTable

## Overview
The big integration commit. DataTable internally uses useDataTableState, resolveColumnWidths, and the new ColumnHeader. Consumer API (tableId, defaultColumns, onCellEdit, etc.) does NOT change.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/src/components/organisms/DataTable/DataTable.tsx` | modify | Major internal refactor |
| `apps/frontend/src/components/organisms/DataTable/columnBuilder.tsx` | modify | Simplify, add columnVariants |
| `apps/frontend/src/components/organisms/DataTable/DragComponents.tsx` | modify | Add width prop to SortableTableCell |
| `apps/frontend/src/styles.css` | modify | Add `html { overflow-x: hidden }` |

## Architecture

### Option B: Hook Inside Component
```
DataTable (consumer API unchanged)
  └── useDataTableState(fields, defaultColumns, searchFields, storageKey: tableId)
  └── resolveColumnWidths(visibleColumnIds, fields, userWidths, containerWidth)
  └── ResizeObserver → containerWidth
  └── Local resize state (resizingColumnId, resizingWidth)
  └── ColumnHeader (draggable, resizable)
  └── DataTableToolbar (search)
  └── FieldsPanel via SecondarySidebar
```

### DataTable.tsx Changes
1. Import and call useDataTableState internally (storageKey = tableId prop)
2. Remove DataTableContext — pass state as props to child components
3. Add ResizeObserver on scroll container for containerWidth
4. Call resolveColumnWidths with tableState data
5. Add resize state (resizingColumnId + resizingWidth) for live preview
6. Compute effectiveColumnWidths = resolved widths merged with live resize override
7. Switch to table-fixed border-separate border-spacing-0
8. Set table style={{ width: tableWidth }}
9. Replace DraggableColumnHeader with ColumnHeader
10. Keep DataTableToolbar wired to tableActions.setSearchQuery
11. Keep FieldsPanel wired to tableActions.setColumnVisibility
12. Keep onCellEdit — pass through to buildColumns

### columnBuilder.tsx Changes
- Keep onCellEdit parameter and MemoizedEditableCell logic
- Add columnVariants parameter (Record<string, ValueVariant>)
- Remove mode parameter
- Cell renderer uses columnVariants[fieldId] ?? 'full'

### DragComponents.tsx Changes
- SortableTableCell: add width prop, apply style={{ width }}
- Border: border-b border-r border-[var(--border-color-muted)] last:border-r-0

### localStorage Migration
In DataTable.tsx's initialization of useDataTableState, add a one-time migration:
- Check for old key `datatable-${tableId}-visible-columns`
- If found, read it, save to new key format, remove old key
- This happens before useDataTableState runs, so the hook picks up the migrated data

## Implementation Steps
1. Update DragComponents.tsx — add width prop
2. Update columnBuilder.tsx — add columnVariants, keep onCellEdit
3. Rewrite DataTable.tsx — the big one
4. Update styles.css — add overflow-x: hidden to html
5. Run build: `cd apps/frontend && bun run build`
6. Commit: `feat: wire column sizing and resize into DataTable`

## Consumer API Preserved
```typescript
interface DataTableProps<T> {
  data: T[];
  fields: Record<string, FieldMeta>;
  defaultColumns: readonly string[];    // kept
  searchFields?: readonly string[];     // kept
  tableId: string;                      // kept (becomes storageKey)
  searchPlaceholder?: string;           // kept
  emptyMessage?: string;                // kept
  noResultsMessage?: string;            // kept
  isLoading?: boolean;                  // kept
  onRowClick?: (item: T) => void;       // kept
  dragPreviewRows?: number;             // kept
  onCellEdit?: CellEditFactory<T>;      // kept
}
```
