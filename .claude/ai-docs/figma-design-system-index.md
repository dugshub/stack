# Figma Design System Index

> **File**: Second Brain - Design System (Deal Brain)
> **Last synced**: 2026-01-23
> **Purpose**: Semantic abstraction layer for Figma MCP access. Use node IDs to pull design context via `get_design_context` or `get_metadata`.
> **Skill**: `.claude/skills/figma-to-code/SKILL.md` — auto-invoked for Figma → code workflows. References this index for node lookups.

---

## Page Map

All pages in the Figma file with their canvas-level node IDs.

### Structure Pages

| Page | Node ID | Purpose |
|------|---------|---------|
| 📔 COVER | `0:1` | Title/cover page |
| 🪙 TOKENS | `34:2122` | Section header for tokens |
| ------ | `34:2123` | Separator |
| 🧱 COMPONENTS | `34:2124` | Section header for components |
| ------ | `34:2125` | Separator |

### Token Pages

| Page | Node ID | Sections |
|------|---------|----------|
| Color | `1:2` | Primitives (`1:36`), Foreground (`32:1493`), Background (`32:1494`), Border (`32:1775`) |
| Effects | TBD | Unknown - requires page navigation |
| Typography | TBD | Unknown - requires page navigation |
| Iconography | `1:3` | Primitives (`32:921`), Iconography (`34:2126`) |

### Component Pages

| Page | Node ID | Status |
|------|---------|--------|
| Button | TBD | Needs discovery |
| Brain Dump | TBD | Needs discovery |
| Checkbox | TBD | Needs discovery |
| Chips | Active page | Frame `129:1359` contains chip variants |
| Citation | TBD | Needs discovery |
| Dropdown | TBD | Needs discovery |
| Form | TBD | Needs discovery |
| Link | TBD | Needs discovery |
| List | TBD | Needs discovery |
| Menu | TBD | Needs discovery |
| Modal | TBD | Needs discovery |
| Navigation | TBD | Needs discovery |
| Radio | TBD | Needs discovery |

---

## Implementation Cross-Reference

**Token file**: `apps/frontend/src/styles/tokens.css`

The implementation includes tokens beyond what's currently visible in Figma variables. The table below shows sync status.

| Token Category | Figma Source | CSS Implementation | Status |
|----------------|-------------|-------------------|--------|
| Color Primitives | Page `1:2`, Section `1:36` | `--color-neutral-*` | Synced |
| Foreground | Page `1:2`, Section `32:1493` | `--foreground-*` | Synced |
| Background | Page `1:2`, Section `32:1494` | `--background-*` | Synced |
| Border Colors | Page `1:2`, Section `32:1775` | `--border-color-*` | Synced |
| Border Radius | Effects page (TBD) | `--border-radius-*` | Likely from Effects |
| Border Strokes | Effects page (TBD) | `--border-stroke-*` | Likely from Effects |
| Shadows | Effects page (TBD) | `--drop-*` | Likely from Effects |
| Typography | Typography page (TBD) | `--text-*`, `--leading-*` | Partial (vars confirm) |
| Spacing | Unknown page | `--space-*` | Implementation-only? |
| Motion | Unknown page | `--duration-*`, `--ease-*` | Implementation-only? |
| Interactive | Background page context | `--color-interactive-*` | Derived from buttons |
| Danger | Unknown | `--color-danger-*` | Not yet seen in Figma |

### Figma Variables (subset returned by `get_variable_defs`)

These are variables the Figma MCP currently returns. The subset depends on node context.

| Variable Path | Value | CSS Equivalent |
|---------------|-------|----------------|
| `foreground/text/main` | `#000000` | `--foreground-text-main` |
| `foreground/text/decorative` | `#808080` | `--foreground-text-decorative` |
| `foreground/icon/main` | `#000000` | `--foreground-icon-main` |
| `foreground/icon/inverse` | `#ffffff` | `--foreground-icon-inverse` |
| `background/surface/main` | `#ffffff` | `--background-surface-main` |
| `background/surface/inverse` | `#000000` | `--background-surface-inverse` |
| `border/color/muted` | `#e6e6e6` | `--border-color-muted` |
| `H3/regular` | Figtree 400 20/30 | `--text-h3` + `--leading-h3` |
| `Copy/base/bold` | Figtree 500 14/22 | `--text-copy-base` + `--leading-copy-base` |
| `Copy/small/bold` | Figtree 500 12/18 | `--text-copy-small` + `--leading-copy-small` |
| `space/space-16` | 16 | `--space-16` |

---

## Color System

### Primitives (Node: `1:36`)

| Token | Hex | CSS Variable |
|-------|-----|-------------|
| `neutral-0` | `#FFFFFF` | `--color-neutral-0` |
| `neutral-50` | `#FAFAFA` | `--color-neutral-50` |
| `neutral-100` | `#E6E6E6` | `--color-neutral-100` |
| `neutral-200` | `#CCCCCC` | `--color-neutral-200` |
| `neutral-300` | `#B3B3B3` | `--color-neutral-300` |
| `neutral-400` | `#999999` | `--color-neutral-400` |
| `neutral-500` | `#808080` | `--color-neutral-500` |
| `neutral-600` | `#666666` | `--color-neutral-600` |
| `neutral-700` | `#4D4D4D` | `--color-neutral-700` |
| `neutral-800` | `#333333` | `--color-neutral-800` |
| `neutral-900` | `#1A1A1A` | `--color-neutral-900` |
| `neutral-950` | `#000000` | `--color-neutral-950` |

### Foreground Tokens (Node: `32:1493`)

| Semantic Token | Primitive | Hex | Usage |
|----------------|-----------|-----|-------|
| `foreground-text-main` | neutral-950 | `#000000` | Primary text |
| `foreground-text-secondary` | neutral-700 | `#4D4D4D` | Supporting text |
| `foreground-text-decorative` | neutral-500 | `#808080` | Placeholder/decorative |
| `foreground-text-disabled` | neutral-300 | `#B3B3B3` | Disabled text |
| `foreground-text-inverse` | neutral-0 | `#FFFFFF` | Text on dark bg |
| `foreground-icon-main` | neutral-950 | `#000000` | Primary icons |
| `foreground-icon-secondary` | neutral-700 | `#4D4D4D` | Secondary icons |
| `foreground-icon-decorative` | neutral-500 | `#808080` | Decorative icons |
| `foreground-icon-disabled` | neutral-300 | `#B3B3B3` | Disabled icons |
| `foreground-icon-inverse` | neutral-0 | `#FFFFFF` | Icons on dark bg |

### Background Tokens (Node: `32:1494`)

| Semantic Token | Primitive | Hex | Usage |
|----------------|-----------|-----|-------|
| `background-surface-main` | neutral-0 | `#FFFFFF` | Primary background |
| `background-surface-secondary` | neutral-50 | `#FAFAFA` | Elevated surfaces |
| `background-surface-bold` | neutral-100 | `#E6E6E6` | Emphasized surfaces |
| `background-surface-inverse` | neutral-950 | `#000000` | Dark surfaces |
| `background-button-primary-default` | neutral-950 | `#000000` | Primary btn default |
| `background-button-primary-hover` | neutral-800 | `#333333` | Primary btn hover |
| `background-button-primary-active` | neutral-950 | `#000000` | Primary btn active |
| `background-button-primary-disabled` | neutral-100 | `#E6E6E6` | Primary btn disabled |
| `background-button-primary-keyboard` | neutral-950 | `#000000` | Primary btn focus |
| `background-button-secondary-default` | neutral-0 | `#FFFFFF` | Secondary btn default |
| `background-button-secondary-hover` | neutral-50 | `#FAFAFA` | Secondary btn hover |
| `background-button-secondary-active` | neutral-100 | `#E6E6E6` | Secondary btn active |
| `background-button-secondary-disabled` | neutral-100 | `#E6E6E6` | Secondary btn disabled |
| `background-button-secondary-keyboard` | neutral-0 | `#FFFFFF` | Secondary btn focus |

### Border Tokens (Node: `32:1775`)

| Semantic Token | Primitive | Hex | Usage |
|----------------|-----------|-----|-------|
| `border-color-main` | neutral-300 | `#B3B3B3` | Default borders |
| `border-color-muted` | neutral-100 | `#E6E6E6` | Subtle borders |
| `border-color-disabled` | neutral-50 | `#FAFAFA` | Disabled borders |
| `border-color-hover` | neutral-500 | `#808080` | Hover state borders |
| `border-color-selected` | neutral-950 | `#000000` | Selected/active borders |

---

## Typography System

**Font Family**: Figtree (`--font-sans: 'Figtree', sans-serif`)

### Type Scale (from tokens.css + Figma variables)

| Token | CSS Size Var | CSS Leading Var | Size | Line Height | Figma Confirmed |
|-------|-------------|-----------------|------|-------------|-----------------|
| H1 | `--text-h1` | `--leading-h1` | 32px | 48px | Needs verification |
| H2 | `--text-h2` | `--leading-h2` | 24px | 36px | Needs verification |
| H3 | `--text-h3` | `--leading-h3` | 20px | 30px | Yes (400 weight) |
| Copy/large | `--text-copy-large` | `--leading-copy-large` | 16px | 24px | Needs verification |
| Copy/base | `--text-copy-base` | `--leading-copy-base` | 14px | 22px | Yes (500 weight for bold) |
| Copy/small | `--text-copy-small` | `--leading-copy-small` | 12px | 18px | Yes (500 weight for bold) |

### Font Weights

From Figma variables, at least Regular (400) and Medium (500) are used. Additional weights (bold/semibold) likely exist on the Typography page.

> **To discover full typography spec**: Navigate to Typography page in Figma, then call `get_metadata()` to capture all type styles, weights, and variants.

---

## Effects System (from tokens.css)

> **Figma page**: Effects (node ID TBD - requires page navigation)

### Shadows

| Token | CSS Variable | Value |
|-------|-------------|-------|
| Highlight | `--drop-highlight` | `0 0 0 2px var(--color-neutral-100)` |
| Rest | `--drop-rest` | `0 1px 2px 0 rgba(0,0,0,0.1)` |
| Hover | `--drop-hover` | `0 2px 4px 0 rgba(0,0,0,0.15)` |
| Active | `--drop-active` | `0 4px 8px 0 rgba(0,0,0,0.2)` |
| Bold | `--drop-bold` | `0 8px 16px 0 rgba(0,0,0,0.25)` |

### Border Radius

| Token | CSS Variable | Value |
|-------|-------------|-------|
| Null | `--border-radius-null` | 0px |
| Small | `--border-radius-small` | 2px |
| Main | `--border-radius-main` | 4px |
| Large | `--border-radius-large` | 8px |

### Border Strokes

| Token | CSS Variable | Value |
|-------|-------------|-------|
| Stroke 1 | `--border-stroke-1` | 1px |
| Stroke 2 | `--border-stroke-2` | 2px |
| Stroke 4 | `--border-stroke-4` | 4px |

---

## Spacing System (from tokens.css)

| Token | CSS Variable | Value |
|-------|-------------|-------|
| 0 | `--space-0` | 0px |
| 1 | `--space-1` | 1px |
| 2 | `--space-2` | 2px |
| 4 | `--space-4` | 4px |
| 8 | `--space-8` | 8px |
| 16 | `--space-16` | 16px |
| 24 | `--space-24` | 24px |
| 32 | `--space-32` | 32px |
| 40 | `--space-40` | 40px |
| 48 | `--space-48` | 48px |
| 56 | `--space-56` | 56px |
| 64 | `--space-64` | 64px |
| 72-120 | `--space-72` through `--space-120` | 72-120px (8px increments) |

---

## Motion System (from tokens.css)

| Token | CSS Variable | Value |
|-------|-------------|-------|
| Fast | `--duration-fast` | 150ms |
| Normal | `--duration-normal` | 200ms |
| Slow | `--duration-slow` | 300ms |
| Ease Out | `--ease-out` | cubic-bezier(0.16, 1, 0.3, 1) |
| Ease In-Out | `--ease-in-out` | cubic-bezier(0.45, 0, 0.55, 1) |

---

## Interactive & Danger Tokens (from tokens.css)

### Interactive (derived from primary button states)

| Token | CSS Variable | Primitive |
|-------|-------------|-----------|
| Default | `--color-interactive-default` | neutral-950 |
| Hover | `--color-interactive-hover` | neutral-800 |
| Active | `--color-interactive-active` | neutral-950 |
| Disabled | `--color-interactive-disabled` | neutral-100 |

### Danger

| Token | CSS Variable | Value |
|-------|-------------|-------|
| Default | `--color-danger-default` | `#e55454` (red-500) |
| Hover | `--color-danger-hover` | red-500 mixed with 15% black |
| Subtle | `--color-danger-subtle` | red-500 mixed with 92% white |
| Border | `--color-danger-border` | red-500 mixed with 60% white |

---

## Iconography (Node: `1:3`)

### Icon Component: `/Ico`

All icons are 16x16px and referenced as component instances with a `type` property.

### Complete Icon Set

| Semantic Token | Figma Component Variant | Category |
|----------------|------------------------|----------|
| `ico-arrow-up` | `type=caret-up` | Navigation |
| `ico-arrow-down` | `type=caret-down` | Navigation |
| `ico-arrow-left` | `type=caret-left` | Navigation |
| `ico-arrow-right` | `type=caret-right` | Navigation |
| `ico-plus` | `type=plus` | Actions |
| `ico-minus` | `type=minus` | Actions |
| `ico-close` | `type=close` | Actions |
| `ico-back` | `type=back` | Navigation |
| `ico-approve` | `type=approve` | Actions |
| `ico-dismiss` | `type=dismiss` | Actions |
| `ico-filter` | `type=filter` | Data |
| `ico-sort` | `type=sort` | Data |
| `ico-group` | `type=group` | Data |
| `ico-order-by` | `type=order` | Data |
| `ico-sort-descending` | `type=sort-descending` | Data |
| `ico-sort-ascending` | `type=sort-ascending` | Data |
| `ico-field` | `type=field` | Data |
| `ico-ext-link` | `type=ext-link` | Navigation |
| `ico-updates` | `type=updates` | Status |
| `ico-account` | `type=account` | User |
| `ico-lock` | `type=lock` | Security |
| `ico-unlock` | `type=unlock` | Security |
| `ico-upload` | `type=upload` | Actions |
| `ico-clipboard` | `type=clipboard` | Actions |
| `ico-grab` | `type=grab` | Interaction |
| `ico-brain` | `type=brain` | Brand |
| `ico-search` | `type=search` | Actions |
| `ico-source` | `type=source` | Data |
| `ico-cmd-select` | `type=cmd-select` | Commands |
| `ico-cmd-open` | `type=cmd-open` | Commands |
| `ico-cmd-copyLink` | `type=cmd-copyLink` | Commands |
| `ico-cmd-@` | `type=cmd-@` | Commands |
| `ico-swap` | `type=swap` | Actions |
| `ico-duplicate` | `type=duplicate` | Actions |
| `ico-create` | `type=create` | Actions |
| `ico-check` | `type=check` | Status |
| `ico-trash` | `type=trash` | Actions |
| `ico-recover` | `type=recover` | Actions |
| `ico-edit` | `type=edit` | Actions |
| `ico-new-view` | `type=new-view` | Navigation |
| `ico-calendar` | `type=calendar` | Data |
| `ico-sync` | `type=sync` | Status |
| `ico-sync-break` | `type=sync-break` | Status |
| `ico-nav-expand` | `type=nav-expand` | Navigation |
| `ico-nav-collapse` | `type=nav-collapse` | Navigation |
| `ico-opportunities` | `type=opportunities` | Domain |
| `ico-clock` | `type=clock` | Data |
| `ico-doc` | `type=doc` | Content |
| `ico-microphone` | `type=microphone` | Media |
| `ico-transcript` | `type=transcript` | Content |
| `ico-pause` | `type=pause` | Media |
| `ico-play` | `type=play` | Media |
| `ico-redo` | `type=redo` | Actions |
| `ico-hint` | `type=hint` | Status |
| `ico-hint-bold` | `type=hint-bold` | Status |
| `ico-context` | `type=context` | Data |
| `ico-ellipsis` | `type=ellipsis` | Actions |
| `ico-instructions` | `type=instructions` | Content |
| `ico-plus-bold` | `type=plus-bold` | Actions |
| `ico-success-bold` | `type=success-bold` | Status |
| `ico-info-bold` | `type=info-bold` | Status |
| `ico-info-outline` | `type=info-outline` | Status |
| `ico-error-bold` | `type=error-bold` | Status |
| `ico-view` | `type=view` | Actions |
| `ico-source-granola` | `type=source-granola` | Sources |
| `ico-source-gcal` | `type=source-gcal` | Sources |
| `ico-source-gmail` | `type=source-gmail` | Sources |
| `ico-source-slack` | `type=source-slack` | Sources |
| `ico-source-gdocs` | `type=source-gdocs` | Sources |
| `ico-source-gsheets` | `type=source-gsheets` | Sources |
| `ico-source-braindump` | `type=source-braindump` | Sources |
| `ico-source-upload` | `type=source-upload` | Sources |
| `ico-source-paste` | `type=source-paste` | Sources |
| `ico-currency-usd` | `type=currency-usd` | Data |
| `ico-freeze` | `type=freeze` | Actions |
| `ico-insert-left` | `type=insert-left` | Actions |
| `ico-insert-right` | `type=insert-right` | Actions |
| `ico-panel-open` | `type=panel-open` | Navigation |
| `ico-panel-collapse` | `type=panel-collapse` | Navigation |
| `ico-quill` | `type=quill` | Content |
| `ico-merge` | `type=merge` | Actions |
| `ico-revert` | `type=revert` | Actions |
| `ico-move` | `type=move` | Actions |
| `ico-settings` | `type=settings` | System |
| `ico-share` | `type=share` | Actions |
| `ico-activity` | `type=activity` | Status |
| `ico-transcript-bold` | `type=transcript-bold` | Content |

---

## Component: Chips (Active Page)

### Structure (Node: `129:1359`)

Chip variants with states and sizes:

| Variant | States | Sizes |
|---------|--------|-------|
| Chip | default, hover, active, disabled, keyboard | base (32px h), small (24px h) |

Node IDs for each variant:

| State | Base | Small |
|-------|------|-------|
| default | `129:1354` | `302:5886` |
| hover | `129:1355` | `302:5898` |
| active | `129:1356` | `302:5910` |
| disabled | `129:1357` | `302:5922` |
| keyboard | `129:1358` | `302:5934` |

---

## Usage Guide

### Pulling Design Context for a Component

```
# Use get_design_context with a known node ID to get implementation-ready code
get_design_context(nodeId="129:1354")  # Gets chip default/base

# Use get_metadata to get structure/layout info
get_metadata(nodeId="1:2")  # Gets Color page structure

# Use get_variable_defs to get current token values
get_variable_defs(nodeId="129:1354")  # Gets variables for that node's context
```

### Checking for Design Changes (Diff Workflow)

1. Call `get_variable_defs()` — compare returned values against this index
2. For color changes: compare against the Color System section
3. For component changes: call `get_metadata(nodeId)` on known component nodes
4. Update this index and `tokens.css` if changes detected

### Implementing a New Component from Figma

1. Find the component page's node ID (see "Discovering" below)
2. Call `get_metadata(nodeId)` to get the structure
3. Call `get_design_context(nodeId)` on specific variants/states for implementation code
4. Reference this index for token mappings (don't hardcode hex values)
5. Use tokens from `apps/frontend/src/styles/tokens.css`

### Discovering Missing Page Node IDs

The Figma MCP can only access canvas (page) nodes by ID, and child nodes on the currently active page. To discover missing pages:

1. Ask the user to navigate to the target page in Figma
2. Call `get_metadata()` without a nodeId — returns currently selected content
3. The page's canvas ID is visible in the returned XML as the root `<canvas>` element
4. Update this index with the discovered page/section node IDs

**Pattern observed**: Page IDs are non-sequential. Known IDs: `0:1`, `1:2`, `1:3`, `34:2122-2125`. Component pages likely have IDs in higher ranges.

### Atoms Already Implemented

These frontend atoms exist and map to Figma components:

| Atom | Path | Figma Page |
|------|------|-----------|
| Button | `src/components/atoms/Button/` | Button |
| Input | `src/components/atoms/Input/` | Form |
| Badge | `src/components/atoms/Badge/` | TBD |
| Text | `src/components/atoms/Text/` | Typography |
| Avatar | `src/components/atoms/Avatar/` | TBD |
| Collapsible | `src/components/atoms/Collapsible/` | TBD |
| Sheet | `src/components/atoms/Sheet/` | Modal |

### Known Limitations

- Page-level canvas node IDs are non-sequential and unpredictable
- Component page IDs require the page to be active in Figma to discover child content
- `get_variable_defs` returns a context-dependent subset of variables
- The Figma MCP cannot list all pages in a document — discovery is manual
- Effects and Typography pages need navigation to capture full token specs
