# Commit 4: Unify ColumnHeader with Resize Handle

## Overview
Replace the simple sort-only ColumnHeader molecule with a full-featured version supporting dnd-kit drag reorder, resize handles, and proper table header styling.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/src/components/molecules/ColumnHeader/ColumnHeader.tsx` | replace | Full ColumnHeader with draggable + resize |
| `apps/frontend/src/components/molecules/ColumnHeader/ColumnHeader.types.ts` | replace | New props interface |
| `apps/frontend/src/components/molecules/ColumnHeader/ColumnHeader.test.tsx` | replace | Updated tests |
| `apps/frontend/src/components/molecules/ColumnHeader/index.ts` | replace | Updated exports |

## Interface

```typescript
interface ColumnHeaderProps {
  id?: string;
  label: string;
  icon?: ReactNode;
  sortable?: boolean;          // default true
  isSorted?: false | 'asc' | 'desc';
  onSort?: (event: unknown) => void;
  draggable?: boolean;         // default false
  isDragging?: boolean;
  width?: number;
  onMeasureRef?: (node: HTMLTableCellElement | null) => void;
  className?: string;
  resizable?: boolean;         // default false
  onResize?: (columnId: string, width: number) => void;
  onResizeEnd?: (columnId: string, width: number) => void;
  onResizeReset?: (columnId: string) => void;
  isResizing?: boolean;
}
```

## Architecture
- `ColumnHeader` is a facade: `draggable={true}` → `DraggableColumnHeaderInner` (uses useSortable), `draggable={false}` → `StaticColumnHeader`
- Both render a `<TableHead>` (th element)
- `ResizeHandle` is an internal sub-component: pointer-based drag, MIN_COLUMN_WIDTH=50, double-click reset
- The DataGrid's current usage of `ColumnHeader` (sort-only content component) must be checked — it may need adjustment since the new ColumnHeader renders a `<th>` instead of content inside a `<th>`

## Implementation Steps
1. Copy all 4 files from reference branch
2. Check if DataGrid imports ColumnHeader — if so, verify compatibility (DataGrid wraps in its own `<TableHead>`, so the new ColumnHeader rendering a `<th>` would double-wrap. DataGrid may need to switch to a different approach or keep importing the sort button content directly)
3. Run tests: `cd apps/frontend && bunx vitest run src/components/molecules/ColumnHeader/ColumnHeader.test.tsx`
4. Run build: `cd apps/frontend && bun run build`
5. Commit: `feat: add ColumnHeader with resize handle`

## Critical Check: DataGrid Compatibility
The existing DataGrid.tsx renders ColumnHeader INSIDE a `<TableHead>`:
```tsx
<TableHead key={header.id} style={{ width: header.getSize() }} icon={iconName ? <Icon name={iconName} /> : undefined}>
  <ColumnHeader label={col.label} sortable={...} sortDirection={...} onSort={...} />
</TableHead>
```
The new ColumnHeader renders its OWN `<th>` (TableHead). This will cause a nested `<th>` if DataGrid isn't updated.

**Resolution:** The DataGrid should NOT import the new ColumnHeader. Keep the DataGrid using its own inline sort button. The simplest fix: the old ColumnHeader's sort-button behavior is so simple that DataGrid can inline it or we add a `SortButton` export. But for this commit, the DataGrid should just keep working — check that it doesn't import from `@/components/molecules/ColumnHeader` directly. If it does, we need to handle it.
