# Perf: Row Virtualization + useRenderPerf Hook

**Branch:** `perf/row-virtualization`

## Overview

Two pieces on one branch: (1) a `useRenderPerf` hook that measures mount time, render count, DOM row count, and TTI — logging to `console.table()` with `[PERF]` prefix; (2) row virtualization for DataTable2 via `@tanstack/react-virtual`, gated behind a `virtualize` prop. DataExplorer defaults to `virtualize={50}`.

## Architecture

```
OpportunitiesIndexPage
  └── useRenderPerf('OpportunitiesPage', { containerRef })
  └── DataExplorer (virtualize={50})
        └── DataTable2
              ├── useVirtualizer(count, getScrollElement, estimateSize: 48, overscan: 5)
              ├── scrollContainerRef → overflow-auto div (lines 500-521)
              └── renderRows()
                    ├── non-virtual: map all filteredRows (unchanged)
                    └── virtual: spacer <tr> + getVirtualItems().map(renderSingleRow) + spacer <tr>
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/package.json` | modify | Add `@tanstack/react-virtual` |
| `apps/frontend/src/hooks/useRenderPerf.ts` | create | Perf measurement hook (~30 lines) |
| `apps/frontend/src/hooks/index.ts` | modify | Barrel export for `useRenderPerf` |
| `apps/frontend/src/components/organisms/DataTable2/DataTable.types.ts` | modify | Add `virtualize?: boolean \| number` |
| `apps/frontend/src/components/organisms/DataTable2/DataTable.tsx` | modify | `useVirtualizer`, `scrollContainerRef`, branched `renderRows` |
| `apps/frontend/src/components/organisms/DataExplorer/DataExplorer.tsx` | modify | Default `virtualize={50}` |
| `apps/frontend/src/components/organisms/DataExplorer/DataExplorer.types.ts` | modify | Add `virtualize?` to `DataExplorerProps` |
| `apps/frontend/src/routes/_authenticated/_shell/dashboard/opportunities/index.tsx` | modify | Add `useRenderPerf` call |

## Interface

```typescript
// useRenderPerf.ts
interface RenderPerfOptions {
  containerRef?: React.RefObject<HTMLElement>;
}
function useRenderPerf(label: string, options?: RenderPerfOptions): void

// DataTable.types.ts — add to DataTableProps<T>
/** true = always, number = auto-enable above threshold, false = never (default) */
virtualize?: boolean | number
```

## Implementation Steps

### 1. Install dependency
```
bun add @tanstack/react-virtual --cwd apps/frontend
```

### 2. Create `useRenderPerf` hook (`hooks/useRenderPerf.ts`)
- Accept `label: string` and optional `{ containerRef }`
- `renderCount` ref — increment on every render (outside effect)
- Mount-only `useEffect`:
  - `performance.mark` + `performance.measure` for mount duration
  - Count `tr` elements via `containerRef.current?.querySelectorAll('tr').length` or document-wide fallback
  - `requestAnimationFrame` callback captures TTI
  - `console.table` with `[PERF]` prefix: `{ label, mountMs, ttiMs, renderCount, domNodes }`
  - Cleanup: `performance.clearMarks` / `performance.clearMeasures`

### 3. Export from barrel (`hooks/index.ts`)
```typescript
export { useRenderPerf } from './useRenderPerf'
```

### 4. Add `virtualize` prop to types (`DataTable.types.ts`)
Add `virtualize?: boolean | number` to `DataTableProps<T>`.

### 5. Modify `DataTable.tsx`

**5a. Imports:** Add `useRef` (if not present) and `import { useVirtualizer } from '@tanstack/react-virtual'`

**5b. Destructure** `virtualize = false` from props.

**5c. Declare refs + virtualizer** (after `filteredRows` is available):
```typescript
const scrollContainerRef = useRef<HTMLDivElement>(null)

const shouldVirtualize =
  typeof virtualize === 'boolean'
    ? virtualize
    : typeof virtualize === 'number'
      ? filteredRows.length > virtualize
      : false

// Called unconditionally (Rules of Hooks) — count:0 when inactive
const rowVirtualizer = useVirtualizer({
  count: shouldVirtualize ? filteredRows.length : 0,
  getScrollElement: () => scrollContainerRef.current,
  estimateSize: () => 48,
  overscan: 5,
})
```

**5d. Extract `renderSingleRow(row, virtualIndex?)`** from the body of `filteredRows.map(...)` inside `renderRows()`. When `virtualIndex` is provided, add `data-index={virtualIndex}` and `ref={rowVirtualizer.measureElement}` to `<TableRow>`.

**5e. Branch `renderRows()`:**
```typescript
const renderRows = () => {
  if (!shouldVirtualize) {
    return filteredRows.map((row) => renderSingleRow(row))
  }
  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()
  const paddingTop = virtualItems[0]?.start ?? 0
  const paddingBottom = totalSize - (virtualItems.at(-1)?.end ?? 0)
  return (
    <>
      {paddingTop > 0 && <tr aria-hidden><td style={{ height: paddingTop, padding: 0, border: 'none' }} /></tr>}
      {virtualItems.map((vi) => {
        const row = filteredRows[vi.index]
        if (!row) return null
        return renderSingleRow(row, vi.index)
      })}
      {paddingBottom > 0 && <tr aria-hidden><td style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>}
    </>
  )
}
```

**5f. Attach `scrollContainerRef`** to the `overflow-auto` wrapper div (~line 501):
```typescript
<div ref={scrollContainerRef} className={cn('flex-1 min-h-0 overflow-auto overscroll-none', ...)}>
```

### 6. Enable in DataExplorer
- Add `virtualize?: boolean | number` to `DataExplorerProps` in `DataExplorer.types.ts`
- In `DataExplorer.tsx`, pass `virtualize={virtualize ?? 50}` to `<DataTable2>`

### 7. Instrument `OpportunitiesIndexPage`
- Import `useRef` and `useRenderPerf`
- `const containerRef = useRef<HTMLDivElement>(null)`
- `useRenderPerf('OpportunitiesPage', { containerRef })`
- Attach `containerRef` to wrapping element or a `<div>` around `<DataExplorer>`

## Open Questions

- `useVirtualizer` with `count: 0` on non-virtual path — verify it's inert
- `estimateSize: 48` assumes `h-12` everywhere; `measureElement` handles dynamic correction but worth verifying
- `ListPageTemplate` may not forward refs — may need a wrapper `<div ref={containerRef}>`
