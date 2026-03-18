# Spec: Make `stack create` work non-interactively

**Goal:** Allow AI agents (and scripts) to run `stack create` without interactive prompts, and auto-kebab-case user input so humans don't have to manually format descriptions.

## Analysis of Current State

The `create` command has three modes:
1. **Explicit** (`stack create <name>`) — prompts for description if `--description` not passed
2. **Auto-detect** (`stack create` on non-trunk) — prompts for confirmation
3. **Retroactive** (`stack create <name> --from ...`) — already fully non-interactive

Problems:
- Mode 1: Missing `--description` triggers interactive prompt — blocks agents
- Mode 2: Confirmation prompt blocks agents
- Description must be pre-formatted as kebab-case — friction for humans

## Changes

### 1. Add `toKebabCase()` helper in `src/lib/branch.ts`

```typescript
export function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanum → hyphen
    .replace(/^-+|-+$/g, '');       // strip leading/trailing hyphens
}
```

### 2. Auto-kebab-case description input in Mode 1

In `src/commands/create.ts`, apply `toKebabCase()` to the description whether it comes from `--description` flag or interactive prompt. Remove the kebab-case validation from the interactive prompt — just auto-convert instead.

**Before (interactive prompt validator):**
```typescript
validate: (value) => {
  if (!value || value.length === 0) return 'Description cannot be empty';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value))
    return 'Must be kebab-case';
  return undefined;
}
```

**After:**
```typescript
validate: (value) => {
  if (!value || value.length === 0) return 'Description cannot be empty';
  return undefined;
}
```

Then after receiving the value (from either source), run `toKebabCase(desc)` and validate the result is non-empty.

### 3. Add `--yes` / `-y` clipanion flag

Declare in `CreateCommand`:
```typescript
yes = Option.Boolean('--yes,-y', false, {
  description: 'Skip confirmation prompts (non-interactive mode)',
});
```

### 4. Non-interactive fallback for Mode 1 (explicit)

When `--description` is not provided AND stdin is not a TTY (or `--yes` is set), error with a clear message instead of hanging on a prompt:

```
Error: --description is required in non-interactive mode
```

Detection: `this.yes || !process.stdin.isTTY`

### 5. Skip confirmation in Mode 2 (auto-detect)

Skip the confirmation prompt when `this.yes || !process.stdin.isTTY`. This lets agents run:
```
stack create --yes
```

### 6. Auto-kebab-case the stack name too

Apply `toKebabCase()` to the stack name positional arg **before** `validateStackName()` (line 59). This means `stack create "Frozen Column"` just works.

Note: Mode 2 auto-derived names from branch parsing are NOT kebab-converted — only user-supplied args.

### 7. Post-conversion validation

After `toKebabCase()` on either name or description, check the result is non-empty. Error message: `"Description resolves to empty after normalization"`.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/branch.ts` | Add `toKebabCase()` export |
| `src/commands/create.ts` | Auto-kebab-case name + description, add `--yes` flag, non-interactive fallback |

## Non-goals
- Changing Mode 3 (retroactive) — already non-interactive
- Adding tests (no test suite exists yet)

## Verification
```bash
# Non-interactive explicit (agent use case)
stack create frozen-column --description "Sticky Header"
# → creates branch dug/frozen-column/1-sticky-header

# Non-interactive auto-detect
stack create --yes

# Interactive still works as before (human use case)
stack create my-stack
# → prompts for description, auto-converts to kebab-case

# Kebab-case auto-conversion on stack name
stack create "My Stack" -d "add schema"
# → stack name: my-stack, branch: dug/my-stack/1-add-schema
```
