# Semantic Theme System

**Goal:** Replace all direct `pc.*` (picocolors) calls with a centralized semantic theme, so styling is intentional, consistent, and trivially re-themeable from one place.

## Design

### New file: `src/lib/theme.ts`

A single object that maps **semantic roles** to picocolors formatters. Every color decision lives here. The rest of the codebase never imports `picocolors` directly.

```typescript
import pc from 'picocolors';
import type { Formatter } from 'picocolors/types';

export interface Theme {
  // Status indicators
  success: Formatter;      // checkmarks, completed actions
  warning: Formatter;      // warnings, caution
  error: Formatter;        // errors, failures

  // Content emphasis
  muted: Formatter;        // secondary info, hints, table headers
  emphasis: Formatter;     // important names, current values
  accent: Formatter;       // markers, highlights ("← you are here")

  // Semantic elements
  branch: Formatter;       // branch names
  stack: Formatter;        // stack names
  pr: Formatter;           // PR numbers (#123)
  command: Formatter;      // command suggestions (`stack submit`)
  label: Formatter;        // section headings
}

const defaultTheme: Theme = {
  success: pc.green,
  warning: pc.yellow,
  error: pc.red,

  muted: pc.dim,
  emphasis: pc.bold,
  accent: pc.cyan,

  branch: pc.bold,
  stack: pc.bold,
  pr: pc.cyan,
  command: pc.cyan,
  label: pc.bold,
};

export const theme = defaultTheme;
```

This means to re-theme the entire CLI, you change ~12 lines in one file. Want branch names in magenta? `branch: pc.magenta`. Want a high-contrast theme? Swap the object.

### Refactor: `src/lib/ui.ts`

Replace ALL `pc.*` calls with `theme.*` calls. Remove `import pc from 'picocolors'`. Add `import { theme } from './theme.js'`.

Complete mapping (every `pc.*` call in the file):

| Location | Before | After |
|----------|--------|-------|
| `success()` | `pc.green('✓')` | `theme.success('✓')` |
| `warn()` | `pc.yellow('⚠')` | `theme.warning('⚠')` |
| `error()` | `pc.red('✗')` | `theme.error('✗')` |
| `info()` | `pc.dim(msg)` | `theme.muted(msg)` |
| `heading()` | `pc.bold(msg)` | `theme.label(msg)` |
| `stackTree()` table headers | `pc.dim('#')` etc | `theme.muted('#')` etc |
| `stackTree()` marker | `pc.cyan('← you are here')` | `theme.accent('← you are here')` |
| `stackTree()` current branch | `pc.bold(branch.name)` | `theme.branch(branch.name)` |
| `branchTable()` marker | `pc.cyan('←')` | `theme.accent('←')` |
| `branchTable()` current branch | `pc.bold(row.name)` | `theme.branch(row.name)` |
| `positionReport()` stack name | `pc.bold(pos.stackName)` | `theme.stack(pos.stackName)` |

### Refactor: `src/commands/nav.ts`

Import `{ theme }` from theme.ts. Apply styling to `showUsage()` output:

- Section headers ("Navigate with:") → `theme.label`
- Direction names (up, down, top, bottom) → `theme.accent`
- Descriptions ("Move toward trunk") → `theme.muted`
- Trunk name in `navUp` info messages → `theme.branch`
- Command suggestions (`git checkout ...`) → `theme.command`

### Refactor: `src/commands/submit.ts`

Import `{ theme }`. Apply to dry-run and summary output:

- Dry-run column headers ("Branch", "Base", "Action") → `theme.muted`
- Branch names in dry-run table → `theme.branch`
- PR actions ("create PR", "update PR #N") → `theme.accent`
- Final summary branch names → `theme.branch`
- Final summary PR numbers (#N) → `theme.pr`

### Refactor: `src/commands/status.ts`

Import `{ theme }`. Apply to:

- `showActiveStack` heading: stack name → `theme.stack` (compose within the heading string)
- `showAllStacks` listing: stack name → `theme.stack`, age → leave in `ui.info` (already muted)

### Refactor: `src/commands/create.ts`

Import `{ theme }`. Apply to:

- Stack name in success messages → `theme.stack`
- Branch name in success messages → `theme.branch`

### Refactor: `src/commands/push.ts`

Import `{ theme }`. Apply to:

- Branch name in success message → `theme.branch`
- Stack name in success message → `theme.stack`

### Refactor: `src/commands/sync.ts`

Import `{ theme }`. Apply to:

- Stack name in success/info messages → `theme.stack`
- Branch names in rebase messages → `theme.branch`

### Refactor: `src/commands/restack.ts`

Import `{ theme }`. Apply to:

- Branch names in success/info messages → `theme.branch`

## Files to create/modify

1. **Create** `src/lib/theme.ts` — the theme definition
2. **Modify** `src/lib/ui.ts` — replace ALL `pc.*` with `theme.*`, remove picocolors import
3. **Modify** `src/commands/nav.ts` — style showUsage() + trunk references
4. **Modify** `src/commands/submit.ts` — style dry-run + summary output
5. **Modify** `src/commands/status.ts` — style headings + stack listings
6. **Modify** `src/commands/create.ts` — style success messages
7. **Modify** `src/commands/push.ts` — style success messages
8. **Modify** `src/commands/sync.ts` — style rebase/success messages
9. **Modify** `src/commands/restack.ts` — style branch names in messages

## Migration rule

After this change, `picocolors` should ONLY be imported in `theme.ts`. No other file should import `pc` directly. Grep for `from 'picocolors'` to verify.

## Non-goals

- No user-facing theme switching (env var, config file) — just the code-level single source of truth
- No new dependencies — picocolors is already installed
- Don't change the actual information displayed, only how it's styled
