# Perf: Replace Radix Tooltip with Native title on Non-Editable Cells

**Branch:** `perf/lazy-tooltips`

## Overview

Every non-editable cell in DataTable2 mounts a full Radix tooltip tree (`Root + Trigger + Portal + Content`) even before the user hovers. With hundreds of rows and multiple non-editable columns, this adds thousands of React component instances. The fix replaces the Radix `<Tooltip>` wrapper at `MemoizedEditableCell.tsx:80-87` with a bare `<span title={reason}>` — one DOM node, zero Radix overhead.

## Architecture

```
MemoizedEditableCell (non-editable branch, lines 80-87)
  BEFORE: <Tooltip> → Root + Trigger + Portal + Content (4 Radix nodes per cell)
  AFTER:  <span title={reason}> (1 DOM node, zero Radix overhead)

OpportunitiesIndexPage
  └── useRenderPerf('OpportunitiesPage')
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/src/components/organisms/DataTable2/MemoizedEditableCell.tsx` | modify | Replace `<Tooltip>` with `<span title={reason}>` at lines 80-87 |
| `apps/frontend/src/hooks/useRenderPerf.ts` | create | Perf measurement hook |
| `apps/frontend/src/hooks/index.ts` | modify | Barrel export for `useRenderPerf` |
| `apps/frontend/src/routes/_authenticated/_shell/dashboard/opportunities/index.tsx` | modify | Add `useRenderPerf` call |

## Interface

No new public interfaces. The change is internal to `MemoizedEditableCell`.

```typescript
// MemoizedEditableCell.tsx — non-editable branch
// BEFORE (lines 80-87):
const reason = column.disabledReason ?? 'This field cannot be edited';
return (
  <Tooltip content={reason} fullWidth>
    <span className="cursor-default truncate px-2 py-0.5 hover:text-[var(--foreground-text-decorative)]">
      {renderCellValue(value, renderColumn, variant, row)}
    </span>
  </Tooltip>
);

// AFTER:
const reason = column.disabledReason ?? 'This field cannot be edited';
return (
  <span
    title={reason}
    className="cursor-default truncate px-2 py-0.5 hover:text-[var(--foreground-text-decorative)]"
  >
    {renderCellValue(value, renderColumn, variant, row)}
  </span>
);
```

## Implementation Steps

### 1. Create `useRenderPerf` hook (`hooks/useRenderPerf.ts`)
Same as other branches — see `perf-row-virtualization.md` spec for details.

### 2. Export from barrel (`hooks/index.ts`)
```typescript
export { useRenderPerf } from './useRenderPerf'
```

### 3. Replace Tooltip in MemoizedEditableCell (`MemoizedEditableCell.tsx`)
- At lines 80-87, replace the `<Tooltip content={reason} fullWidth>` wrapper with a `<span title={reason}>` that has the same className
- Remove the nested `<span>` (now redundant — the title span IS the wrapper)
- Check if `Tooltip` import (line 2) is still used elsewhere in the file — if not, remove it

### 4. Instrument `OpportunitiesIndexPage`
- Import `useRenderPerf` from `@/hooks`
- Call `useRenderPerf('OpportunitiesPage')` inside the component

## Open Questions

- Native `title` has browser-controlled delay (~500ms) and OS-level styling — acceptable for informational "can't edit" tooltips?
- Should `useRenderPerf` be kept permanently behind `import.meta.env.DEV` or removed before merge?
