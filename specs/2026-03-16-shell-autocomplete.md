# Shell Autocomplete

**Date:** 2026-03-16
**Status:** Draft

## Problem

Typing `stack my-fea<TAB>` does nothing. Stack names, branch names, command names, and flags all require exact recall. With more stacks and the new `stack <name>` navigation, tab completion becomes high-value ergonomics.

## What Needs Completing

### 1. Command names (static)

```
stack st<TAB>  →  status / submit / sync
stack cr<TAB>  →  create
```

Commands: `absorb`, `create`, `delete`, `init`, `merge`, `nav`, `push`, `remove`, `restack`, `status`, `submit`, `sync`, `undo`, `update`.

### 2. Stack names (dynamic — from state file)

Used in two positions:

- **Bare argument to default command:** `stack my-fea<TAB>` → `my-feature`
- **`--stack` / `-s` flag value:** `stack submit -s my-<TAB>` → `my-feature`
- **`stack delete` argument:** `stack delete old-<TAB>` → `old-feature`

Source: `~/.claude/stacks/<repo>.json` → `Object.keys(state.stacks)`.

Challenge: Need to resolve which repo we're in to find the right state file. The completion function must run `git rev-parse --show-toplevel` and derive the repo basename, same as `state.ts` does.

### 3. Nav directions (static, positional)

```
stack nav u<TAB>  →  up
stack nav d<TAB>  →  down
```

Values: `up`, `down`, `top`, `bottom`.

### 4. Flags (static per command)

```
stack submit --d<TAB>  →  --dry-run
stack delete --b<TAB>  →  --branches
```

Most commands share `--stack` / `-s`. Notable per-command flags:
- `submit`: `--dry-run`, `--draft`, `--stack`
- `delete`: `--branches`, `--prs`
- `create`: `--description`, `--from`
- `merge`: `--all`, `--strategy`
- `restack`: `--continue`, `--abort`

## Approach: Custom Completion Script (not clipanion)

Clipanion has **no built-in shell completion support**. Its `Cli` class exposes `definitions()` which returns command metadata, but no completion generation.

Two options considered:

| Approach | Pros | Cons |
|----------|------|------|
| **A. `stack completions` subcommand** that emits shell scripts | Single source of truth, dynamic completions possible, matches `gh`, `docker`, `kubectl` pattern | Requires shell eval on startup |
| **B. Static scripts bundled in repo** | No runtime dependency | Stale when commands change, can't do dynamic stack names |

**Decision: Approach A.** A `stack completions <shell>` command that prints a completion script to stdout. This is the standard pattern used by `gh completion`, `docker completion`, `kubectl completion`, etc.

## Shell Completion Scripts

### How they work

Each shell has a different completion API. The pattern is:

1. `stack completions bash` prints a bash completion script
2. User adds `eval "$(stack completions bash)"` to `.bashrc`
3. On each `<TAB>`, bash calls a function that runs `stack --completions <args>` to get candidates

This means two pieces:
- **Completion script** (shell-specific): Registers the completion function with the shell
- **Completion handler** (TypeScript): Parses partial input and returns candidates, one per line

### Bash

```bash
_stack_completions() {
    local candidates
    candidates=$(stack --completions -- "${COMP_WORDS[@]:1}" 2>/dev/null)
    COMPREPLY=($(compgen -W "$candidates" -- "${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _stack_completions stack
```

### Zsh

```zsh
_stack() {
    local candidates
    candidates=("${(@f)$(stack --completions -- "${words[@]:1}" 2>/dev/null)}")
    compadd -a candidates
}
compdef _stack stack
```

### Fish

```fish
complete -c stack -f -a "(stack --completions -- (commandline -cop) 2>/dev/null)"
```

## Completion Handler: `--completions`

A hidden flag on the CLI entry point. When present, the CLI switches to completion mode instead of executing a command.

```
stack --completions -- submit --s
→ --stack
→ --stack=

stack --completions -- ""
→ absorb
→ create
→ delete
→ (all commands)
→ (all stack names)

stack --completions -- nav ""
→ up
→ down
→ top
→ bottom

stack --completions -- delete ""
→ (all stack names)

stack --completions -- submit -s ""
→ (all stack names)
```

### Resolution logic

```
function getCompletions(args: string[]): string[] {
  const [command, ...rest] = args;
  const current = rest[rest.length - 1] ?? '';
  const prev = rest[rest.length - 2] ?? '';

  // No command yet — complete commands + stack names
  if (!command || args.length === 1) {
    return [...COMMANDS, ...getStackNames()];
  }

  // Flag value position: --stack <cursor> or -s <cursor>
  if (prev === '--stack' || prev === '-s') {
    return getStackNames();
  }

  // Flag name position: --<partial>
  if (current.startsWith('-')) {
    return getFlagsForCommand(command);
  }

  // Positional completions per command
  switch (command) {
    case 'nav':
      return ['up', 'down', 'top', 'bottom'];
    case 'delete':
      return getStackNames();
    default:
      return [];
  }
}
```

### Getting stack names (fast path)

The completion handler must be fast (<100ms). Reading the JSON state file is fast. Running `git rev-parse` to find the repo name is fast. No network calls.

```typescript
function getStackNames(): string[] {
  try {
    const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel']);
    const repoName = path.basename(toplevel.stdout.toString().trim());
    const statePath = path.join(homedir(), '.claude', 'stacks', `${repoName}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    return Object.keys(state.stacks);
  } catch {
    return [];
  }
}
```

## Installation: `stack completions install`

Two subcommands:

- `stack completions bash|zsh|fish` — print script to stdout (for manual setup)
- `stack completions install` — auto-detect shell and append to rc file

Auto-install logic:

```
1. Detect shell from $SHELL
2. Choose rc file:
   - bash → ~/.bashrc (or ~/.bash_profile on macOS)
   - zsh  → ~/.zshrc
   - fish → ~/.config/fish/completions/stack.fish
3. Check if already installed (grep for "stack completions")
4. Append eval line (bash/zsh) or write file (fish)
5. Print instructions: "Restart your shell or run: source ~/.zshrc"
```

Fish is special: it uses a file in `~/.config/fish/completions/` rather than an eval line.

## File Layout

```
src/
  commands/
    completions.ts       # `stack completions <bash|zsh|fish|install>`
  lib/
    completions.ts       # getCompletions(args) → string[]
  cli.ts                 # Add --completions intercept before cli.run()
```

## Changes to cli.ts

The `--completions` flag must be intercepted **before** clipanion's `cli.run()`, since it's not a real command — it's a mode switch. Similar to how `--help` is already intercepted.

```typescript
// In cli.ts, after arg normalization:
if (args[0] === '--completions' && args[1] === '--') {
  const { getCompletions } = await import('./lib/completions.js');
  const candidates = getCompletions(args.slice(2));
  process.stdout.write(candidates.join('\n'));
  process.exit(0);
}
```

This must:
- Skip the git-repo check (completions should work even outside a repo, just without stack names)
- Skip the update check
- Write to stdout (not stderr) since shells read stdout
- Exit immediately

## Flag Registry

To avoid maintaining a separate list of flags, extract them from clipanion's `definitions()` API at completion time. Each definition includes option metadata (name, aliases, type).

Alternatively, maintain a static map since command set is small and stable:

```typescript
const COMMAND_FLAGS: Record<string, string[]> = {
  submit: ['--dry-run', '--draft', '--stack', '-s'],
  delete: ['--branches', '--prs'],
  create: ['--description', '-d', '--from'],
  merge:  ['--all', '--strategy'],
  restack: ['--continue', '--abort'],
  // ... shared flags
};
```

**Recommendation:** Use `cli.definitions()` dynamically. It's already available and stays in sync automatically. The definitions include option `nameSet` arrays.

## Edge Cases

1. **Not in a git repo:** Return only static completions (commands, global flags). No stack names.
2. **No state file:** Return only static completions. Fail silently.
3. **Repo with no stacks:** Return only static completions.
4. **Multiple stacks with similar prefixes:** Shell handles disambiguation naturally.
5. **`stack <name>` ambiguity:** Both commands and stack names complete in first position. Stack names that conflict with commands are already rejected by `validateStackName()`, so no overlap.
6. **Performance:** No network calls, no gh commands. Just git rev-parse + JSON parse. Should be <50ms.

## Implementation Order

1. **`src/lib/completions.ts`** — Core `getCompletions()` function with tests against known inputs
2. **`--completions` intercept in `cli.ts`** — Wire up the hidden flag
3. **`src/commands/completions.ts`** — `stack completions bash|zsh|fish` script output
4. **`stack completions install`** — Auto-detect and install to rc file
5. **Manual testing** on bash, zsh, fish

## Open Questions

1. **Should `stack init` also install completions?** It currently installs Claude Code skills. Could add a `--completions` flag or prompt.
2. **Should we use `cli.definitions()` or a static flag map?** Dynamic is more maintainable but requires importing and registering all commands just for completions. Static is simpler but can drift.
3. **Branch name completion:** Should `stack create --from <TAB>` complete git branch names? This would require `git branch --list` which is fast but adds scope. Defer to v2.
4. **`compdef` vs `bashcompinit`:** Some zsh setups need `bashcompinit` for bash-style completions. The native zsh approach (`compdef`) is better but more complex for descriptions. Start with simple `compadd`, upgrade later.
