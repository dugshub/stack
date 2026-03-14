---
name: frontend-development
description: Enforces the Tempo atomic design system architecture when building or modifying frontend components. Use when creating new components, refactoring existing ones, reviewing component architecture, or when someone asks about where code should live. Ensures strict layer boundaries between atoms, molecules, organisms, hooks, and utils.
---

# Atomic Frontend Developer — Tempo Design System

You are a frontend architect building components for the Tempo (Deal Brain) application. You follow strict atomic design principles with clear ownership boundaries. Every component, hook, and utility you create or modify must respect these rules.

## The Golden Rule

**Each layer has one job:**

| Layer | Owns | Never owns |
|-------|------|------------|
| Atoms | Pixels (markup + styling) | State, behavior, data shape |
| Molecules | One interaction (local state only) | Cross-component state, data fetching |
| Organisms | Composition + wiring | Styling details, business logic |
| Hooks | Stateful logic (React state, effects, persistence) | JSX, visual output |
| Utils | Pure functions (no side effects) | React state, DOM access |

## Atoms — Pure Visual Building Blocks

Atoms are the smallest visual primitives. They render semantic HTML, apply design tokens, and nothing else.

### Rules
- **Extend native HTML attributes** — `HTMLAttributes<HTMLTableElement>`, `ButtonHTMLAttributes`, etc.
- **Use CVA for variants** — size, color, visual mode. Never behavioral variants.
- **Use `forwardRef`** — Always. Set `displayName`.
- **Zero dependencies on other layers** — No hooks, no data types, no business logic.
- **Compound components are one atom** — `Table` + `TableRow` + `TableHead` + `TableCell` is one atom with multiple exports, not four atoms. They're co-dependent parts of the same primitive (like `<select>` needs `<option>`).

### File Structure
```
atoms/ComponentName/
├── ComponentName.tsx          # Implementation with forwardRef + displayName
├── ComponentName.types.ts     # Props extending native HTML element attributes
├── ComponentName.variants.ts  # CVA variant definitions (visual only)
├── ComponentName.test.tsx     # Behavioral tests with RTL
└── index.ts                   # Named exports
```

### What belongs here
- `Table`, `TableRow`, `TableHead`, `TableCell` (compound component)
- `Button`, `Input`, `Checkbox`, `Badge`, `Icon`
- `Text`, `Link`, `Chip`, `Tabs`

### What does NOT belong here
- `DraggableColumnHeader` — that's behavior, not a visual primitive
- `EditableCell` — that's an interaction pattern
- Any component that imports `@dnd-kit`, `@tanstack/react-table`, or similar

## Molecules — Single-Concern Behavioral Additions

Molecules compose atoms with **exactly one** behavioral concern. They own only their own local interaction state.

### Rules
- **Compose atoms** — A molecule wraps one or more atoms and adds one interaction.
- **Local state only** — `useState`/`useRef` for own interaction (is my handle active? is my input focused?). Never cross-component state.
- **Callback interface** — Report changes up via props (`onResize`, `onSort`, `onChange`). Never manage external state.
- **No data shape knowledge** — A molecule doesn't know about `FieldMeta`, `Opportunity`, or any business type. It works with generic props.
- **No heavy infrastructure** — No `DndContext`, no `useReactTable()`, no context providers.

### Examples

**Good molecules:**
```
SortableColumnHeader  — wraps TableHead + adds sort click handler + indicator icon
ResizableColumnHeader — wraps TableHead + adds pointer-event resize handle
ResizeHandle          — the draggable edge element (fires onResize callback)
EditableCell          — wraps TableCell + adds click-to-edit with save/cancel
ExpandableRow         — wraps TableRow + adds expand/collapse with content slot
SelectableRow         — wraps TableRow + adds checkbox selection
SearchInput           — wraps Input + adds search icon + clear button
ColumnHeader          — wraps TableHead + adds sort indicator
FieldsPanel           — manages column visibility UI (browse/search modes)
Toolbar               — layout container for action buttons
```

**Bad molecules (these are organisms):**
```
DraggableColumnHeader — owns dnd-kit + resize + sort (three concerns)
DataGrid              — owns TanStack Table integration (orchestration)
```

### Composition Pattern
Molecules can wrap other molecules when the concerns are orthogonal:
```tsx
<ResizableColumnHeader width={w} onResize={handleResize}>
  <SortableColumnHeader direction="asc" onSort={handleSort}>
    {label}
  </SortableColumnHeader>
</ResizableColumnHeader>
```

Each molecule adds one layer of behavior. The organism decides which molecules to compose.

## Organisms — Compose and Wire

Organisms compose molecules and connect them to hooks. They own the coordination layer.

### Rules
- **Compose, don't implement** — Organisms wire molecules together and connect them to hooks. They don't implement interaction handlers directly.
- **Own cross-component state via hooks** — Use custom hooks for state management, not inline `useState` chains.
- **Infrastructure lives here** — `DndContext`, `SortableContext`, context providers, `useReactTable()`.
- **Keep them thin** — If an organism exceeds ~200 lines, extract hooks or split into sub-organisms.
- **No styling details** — Use atoms/molecules for visual concerns. Organisms handle layout at most.

### The InteractiveTable Pattern
```tsx
function InteractiveTable({ columns, data }) {
  const sort = useSortState();
  const widths = useColumnWidths(tableId, columnIds);
  const order = useColumnOrder(columnIds);

  return (
    <DndContext onDragEnd={order.handleDragEnd}>
      <Table>
        <TableHeader>
          {order.orderedColumns.map(col => (
            <ResizableColumnHeader
              width={widths.get(col.id)}
              onResize={widths.onResize}
            >
              <SortableColumnHeader
                direction={sort.getDirection(col.id)}
                onSort={() => sort.toggle(col.id)}
              />
            </ResizableColumnHeader>
          ))}
        </TableHeader>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.id}>
              {order.orderedColumns.map(col => (
                <TableCell key={col.id}>{renderCell(row, col)}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DndContext>
  );
}
```

### Organism Hierarchy
- **`InteractiveTable`** — Table with sorting, resizing, reordering. No toolbar, no search, no panels. Reusable anywhere you need a table with interactive columns.
- **`DataTable`** — Page-level orchestrator. Composes InteractiveTable + Toolbar + FieldsPanel + cell editing + localStorage persistence. Specific to the list-page pattern.

## Hooks — Stateful Logic Without JSX

Hooks own React state, effects, and persistence. They never render anything.

### Rules
- **No JSX** — Hooks return data and callbacks, never components.
- **Single responsibility** — One hook, one concern.
- **Pure interface** — Accept configuration, return state + handlers.
- **Persistence is a hook concern** — localStorage, URL params, API calls.

### Table Hooks

| Hook | Owns | Returns |
|------|------|---------|
| `useColumnWidths(tableId, columns)` | Width state + localStorage persistence | `{ widths, onResize, onResizeEnd, onResizeReset }` |
| `useColumnOrder(columnIds)` | Column order + drag handlers | `{ orderedColumns, handleDragEnd, handleDragStart }` |
| `useSortState(defaultSort?)` | Sort direction per column | `{ sorting, toggle, getDirection, clear }` |
| `useColumnVisibility(tableId, defaults)` | Which columns are shown + persistence | `{ visibleIds, show, hide, toggle, reset }` |
| `useTableFilter(data, searchFields)` | Filtered data from search query | `{ filtered, query, setQuery }` |
| `useEditableCell(onSave)` | Edit state machine (idle→editing→saving) | `{ isEditing, draft, start, cancel, save }` |

### Hook Composition
Hooks can compose other hooks internally:
```ts
function useDataTableState(tableId, columns) {
  const widths = useColumnWidths(tableId, columns);
  const order = useColumnOrder(columns);
  const sort = useSortState();
  const visibility = useColumnVisibility(tableId, columns);
  // Returns a unified interface
}
```

## Utils — Pure Functions

Utils are pure functions with no React, no state, no side effects.

### Rules
- **No React imports** — No hooks, no JSX, no context.
- **No side effects** — No localStorage, no DOM, no fetch.
- **Deterministic** — Same input always produces same output.
- **Testable in isolation** — No mocking required.

### Table Utils

| Util | Purpose | Location |
|------|---------|----------|
| `defaultWidthForType(type)` | Map field type to default column width | `lib/table/column-widths.ts` |
| `clampWidth(width, min, max)` | Constrain width to bounds | `lib/table/column-widths.ts` |
| `reorderArray(arr, from, to)` | Move item in array (for column reorder) | `lib/table/reorder.ts` |
| `formatCellValue(value, type)` | Format raw value for display | `lib/table/cell-format.ts` |
| `coerceFieldValue(value, type)` | Coerce edited value to correct type | `lib/table/cell-coerce.ts` |
| `matchesFilter(row, query, fields)` | Test if a row matches search | `lib/table/filter.ts` |
| `sortComparator(type)` | Return comparator function for a field type | `lib/table/sort.ts` |

### Location
Utils go in `lib/table/` (or `lib/<domain>/` for other domains). Not in component directories.

## Decision Tree: Where Does This Code Go?

```
Does it render JSX?
├── YES: Is it a pure visual primitive with no behavior?
│   ├── YES → Atom
│   └── NO: Does it add exactly ONE interaction to an atom?
│       ├── YES → Molecule
│       └── NO: Does it compose multiple molecules/atoms with hooks?
│           ├── YES → Organism
│           └── NO → Re-think. Break it down further.
└── NO: Does it use React hooks (useState, useEffect, useRef)?
    ├── YES → Custom Hook (in hooks/ or co-located)
    └── NO → Utility function (in lib/)
```

## Anti-Patterns to Reject

### God Components
If a component exceeds ~200 lines or manages more than 2-3 state variables, it needs splitting. Extract hooks for state, split into sub-organisms, or push concerns down to molecules.

### Molecules That Know Too Much
A molecule should never import business types (`FieldMeta`, `Opportunity`, `User`). It works with generic props: `value: string`, `onChange: (v: string) => void`, `options: { label: string; value: string }[]`.

### Atoms With Behavior
If you're adding `onClick` handlers, `useState`, or conditional logic to an atom — stop. That's a molecule.

### Hooks That Render
If your hook returns JSX or a component — stop. That's a component, not a hook. Hooks return data.

### Utils With Side Effects
If your util reads localStorage, accesses the DOM, or makes API calls — stop. That's a hook.

### Skipping Layers
Don't jump from atom to organism. If an organism renders an atom with behavior, there's a missing molecule in between. The molecule makes that behavior reusable.

## Design Token Usage

Always use design tokens from `apps/frontend/src/styles/tokens.css`. Never hardcode colors, spacing, or typography.

```tsx
// GOOD
className="text-[var(--foreground-text-main)] py-[var(--space-8)]"

// BAD
className="text-black py-2"  // Hardcoded, not from tokens
className="text-sm"           // Tailwind default, not design system
```

Use the design system's text scale (`text-copy-small`, `text-copy-base`, `leading-copy-base`) over Tailwind defaults (`text-sm`, `text-base`).

## Testing by Layer

| Layer | Test Strategy |
|-------|--------------|
| Atoms | Visual: renders correct HTML, applies variants, forwards refs |
| Molecules | Behavioral: user interactions trigger callbacks, local state works |
| Organisms | Integration: molecules compose correctly, hooks wire properly |
| Hooks | Unit: state transitions, persistence, edge cases |
| Utils | Unit: pure input/output, edge cases, type coercion |

All tests use **Vitest + React Testing Library**. Test behavior (roles, text, user events), not implementation (class names, internal state).
