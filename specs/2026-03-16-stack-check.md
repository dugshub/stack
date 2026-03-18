# Spec: `stack check` — Run a command across every branch in a stack

## Motivation

After editing multiple branches in a stack (rebasing, restacking, absorbing), you need to verify each branch still builds/passes. Today this requires manually checking out each branch and running your command. The `stack check` command automates this: iterate through each branch, run a configurable command, report pass/fail per branch.

## Usage

```bash
stack check <command...>               # run on all branches
stack check --from 3 <command...>      # start from branch 3
stack check --bail <command...>        # stop on first failure
stack check --json <command...>        # structured output
stack check --parallel <command...>    # use git worktrees (concurrent)
```

### Examples

```bash
stack check bun tsc --noEmit
stack check "cd apps/frontend && bun tsc --noEmit"
stack check npm test
stack check --bail --from 5 bun tsc --noEmit
stack check --parallel make build
```

## Design

### Sequential mode (default)

1. Resolve current stack via `resolveStack()` (wrapped in try/catch → `ui.error()`, return 2)
2. Record current branch + check for dirty working tree
3. If dirty, stash with a tagged message (`stack-check-stash`). If stash fails, abort with error (return 2).
4. Parse `--from` (1-indexed, default 1) to get branch slice: `branches.slice(from - 1)`
5. For each branch (in stack order, bottom → top):
   - `git checkout <branch>` (quiet)
   - Spawn command via `Bun.spawnSync(['sh', '-c', command.join(' ')], ...)`
   - Capture exit code
   - Record result: `{ branch, index, exitCode, ok, durationMs }`
6. Restore original branch (`git checkout <original>`)
7. Pop stash if we stashed
8. Print results table

### Parallel mode (`--parallel`)

**Deferred to v2.** The parallel worktree approach (temp worktrees + `Bun.spawn()`) adds significant complexity (worktree conflict detection, output interleaving, async orchestration). The sequential mode delivers the core value. Parallel can be added later when the pattern proves useful.

Design notes for future reference:
- Use `git worktree add <tmpdir> <branch>` per branch
- Run commands via `Bun.spawn(['sh', '-c', ...], { cwd: worktreePath })`
- Buffer output per-branch, print after all complete
- Check `git.worktreeList()` for conflicts before creating
- Clean up all worktrees in `finally` block

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--from` | string (coerced to number) | 1 | Start from branch N (1-indexed) |
| `--bail` | boolean | false | Stop on first non-zero exit |
| `--json` | boolean | false | Output results as JSON to stdout |
| `--stack` / `-s` | string | (resolved) | Target stack by name |
| `--quiet` / `-q` | boolean | false | Suppress command output, show only summary |

Note: `--to` and `--parallel` deferred to v2.

### Output

**Default (table to stderr):**
```
Checking stack: feature-x (7 branches)
Running: bun tsc --noEmit

 #  Branch                              Status    Time
 1  dug/feature-x/1-add-schema          ✓ pass    1.2s
 2  dug/feature-x/2-migrate-data        ✓ pass    1.1s
 3  dug/feature-x/3-update-api          ✓ pass    1.3s
 4  dug/feature-x/4-add-types           ✗ FAIL    0.8s
 5  dug/feature-x/5-update-ui           ✗ FAIL    0.9s
 6  dug/feature-x/6-context-menu        ✗ FAIL    1.0s
 7  dug/feature-x/7-rename-internals    ✗ FAIL    0.7s

4 of 7 failed
```

**JSON mode (to stdout):**
```json
{
  "stack": "feature-x",
  "command": "bun tsc --noEmit",
  "results": [
    { "branch": "dug/feature-x/1-add-schema", "index": 1, "exitCode": 0, "ok": true, "durationMs": 1234 }
  ],
  "passed": 3,
  "failed": 4,
  "total": 7
}
```

**Quiet mode (`-q`):** suppresses the command's own stdout/stderr; only shows the summary table.

### Exit code

- `0` if all branches pass
- `1` if any branch fails
- `2` for usage/setup errors (not in a stack, bad --from, etc.)

## Implementation

### New file: `src/commands/check.ts`

```typescript
import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';
import { resolveStack } from '../lib/resolve.js';
import { loadAndRefreshState } from '../lib/state.js';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';
import type { Branch, CheckResult } from '../lib/types.js';

export class CheckCommand extends Command {
  static override paths = [['check']];

  static override usage = Command.Usage({
    description: 'Run a command on every branch in the stack',
    examples: [
      ['Type-check all branches', 'stack check bun tsc --noEmit'],
      ['Stop on first failure', 'stack check --bail npm test'],
      ['Start from branch 5', 'stack check --from 5 make build'],
    ],
  });

  stackName = Option.String('--stack,-s', { description: 'Target stack by name' });
  from = Option.String('--from', { description: 'Start from branch N (1-indexed)' });
  bail = Option.Boolean('--bail', false, { description: 'Stop on first failure' });
  json = Option.Boolean('--json', false, { description: 'Output as JSON to stdout' });
  quiet = Option.Boolean('--quiet,-q', false, { description: 'Suppress command output' });
  command = Option.Rest({ required: 1 });

  async execute(): Promise<number> {
    const state = loadAndRefreshState();

    // 1. Resolve stack
    let resolved;
    try {
      resolved = await resolveStack({ state, explicitName: this.stackName });
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      return 2;
    }

    const { stackName, stack } = resolved;
    const cmdStr = this.command.join(' ');

    // 2. Parse --from, validate range
    const fromIndex = this.from ? parseInt(this.from, 10) : 1;
    if (isNaN(fromIndex) || fromIndex < 1 || fromIndex > stack.branches.length) {
      ui.error(`--from must be between 1 and ${stack.branches.length}`);
      return 2;
    }
    const branches = stack.branches.slice(fromIndex - 1);

    // 3. Print banner (unless JSON)
    if (!this.json) {
      ui.heading(`\nChecking stack: ${theme.stack(stackName)} (${stack.branches.length} branches)`);
      ui.info(`Running: ${cmdStr}\n`);
    }

    // 4. Run checks
    const results = runSequential(branches, this.command, fromIndex, {
      bail: this.bail,
      quiet: this.quiet || this.json, // suppress output in JSON mode too
    });

    // 5. Output results
    if (this.json) {
      const passed = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok).length;
      const output = {
        stack: stackName,
        command: cmdStr,
        results,
        passed,
        failed,
        total: results.length,
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      ui.checkResultsTable(results);
      const failed = results.filter(r => !r.ok).length;
      if (failed > 0) {
        process.stderr.write(`\n${theme.error(`${failed} of ${results.length} failed`)}\n\n`);
      } else {
        process.stderr.write(`\n${theme.success(`All ${results.length} passed`)}\n\n`);
      }
    }

    // 6. Exit code
    return results.some(r => !r.ok) ? 1 : 0;
  }
}

function runSequential(
  branches: Branch[],
  command: string[],
  startIndex: number,
  opts: { bail: boolean; quiet: boolean },
): CheckResult[] {
  const originalBranch = git.currentBranch();
  const wasDirty = git.isDirty();

  if (wasDirty) {
    try {
      git.stashPush({ includeUntracked: true, message: 'stack-check-stash' });
    } catch {
      ui.error('Failed to stash dirty working tree. Commit or stash manually first.');
      return [];
    }
  }

  const results: CheckResult[] = [];
  try {
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i]!;
      const branchIndex = startIndex + i; // 1-indexed position in full stack

      git.checkout(branch.name);

      const start = performance.now();
      const result = Bun.spawnSync(['sh', '-c', command.join(' ')], {
        stdout: opts.quiet ? 'pipe' : 'inherit',
        stderr: opts.quiet ? 'pipe' : 'inherit',
      });
      const durationMs = performance.now() - start;

      results.push({
        branch: branch.name,
        index: branchIndex,
        exitCode: result.exitCode,
        ok: result.exitCode === 0,
        durationMs,
      });

      if (opts.bail && result.exitCode !== 0) break;
    }
  } finally {
    git.tryRun('checkout', originalBranch);
    if (wasDirty) {
      try { git.stashPop(); } catch { /* stash may have been consumed */ }
    }
  }
  return results;
}
```

### Add `CheckResult` to `src/lib/types.ts`

```typescript
export interface CheckResult {
  branch: string;
  index: number;
  exitCode: number;
  ok: boolean;
  durationMs: number;
}
```

### Add `checkResultsTable` to `src/lib/ui.ts`

```typescript
export function checkResultsTable(results: CheckResult[]): void {
  const numW = String(Math.max(...results.map(r => r.index))).length;
  const branchW = Math.max(6, ...results.map(r => r.branch.length));
  const gap = '  ';

  // Header
  process.stderr.write(` ${theme.muted('#'.padEnd(numW))}${gap}${theme.muted('Branch'.padEnd(branchW))}${gap}${theme.muted('Status'.padEnd(8))}${gap}${theme.muted('Time')}\n`);

  for (const r of results) {
    // Pad plain text FIRST, then apply color (ANSI codes break padEnd)
    const statusPlain = r.ok ? '✓ pass' : '✗ FAIL';
    const statusPadded = statusPlain.padEnd(8);
    const statusStr = r.ok ? theme.success(statusPadded) : theme.error(statusPadded);

    const time = `${(r.durationMs / 1000).toFixed(1)}s`;
    process.stderr.write(` ${String(r.index).padEnd(numW)}${gap}${r.branch.padEnd(branchW)}${gap}${statusStr}${gap}${time}\n`);
  }
}
```

### Registration in `src/cli.ts`

Import and register:
```typescript
import { CheckCommand } from './commands/check.js';
cli.register(CheckCommand);
```

Add to help text (in the submit/restack/sync group):
```typescript
['check <cmd...>',           'Run a command on every branch'],
```

## Edge cases

1. **Dirty working tree:** Auto-stash (includeUntracked), restore in finally. If stash fails, abort with error (return 2).
2. **Restack in progress:** `resolveStack` already handles this with appropriate errors.
3. **Branch doesn't exist locally:** `git.checkout()` will throw → catch in loop, record as FAIL with exitCode -1, continue.
4. **Command not found:** `Bun.spawnSync` returns non-zero exit code → recorded as FAIL.
5. **`--from` > branch count:** Validated upfront, returns exit code 2.
6. **Ctrl+C during run:** `finally` block restores original branch and pops stash.
7. **Empty command (no args after flags):** `Option.Rest({ required: 1 })` handles this — clipanion errors before execute().

## Scope

- **In scope (v1):** Sequential check, `--from`, `--bail`, `--json`, `--quiet`, results table, CLI registration.
- **Deferred (v2):** `--parallel` (worktrees), `--to` range end.
- **Out of scope:** Persisting check results, CI integration, caching.

## Files to create/modify

| File | Action |
|------|--------|
| `src/commands/check.ts` | Create — new command |
| `src/cli.ts` | Edit — import, register, add to help text |
| `src/lib/ui.ts` | Edit — add `checkResultsTable()` + import `CheckResult` |
| `src/lib/types.ts` | Edit — add `CheckResult` interface |
