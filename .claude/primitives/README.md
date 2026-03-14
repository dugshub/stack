# Primitives

Primitives are configurable context that customize how commands and agents behave. Think of them as dependency injection for AI workflows.

## How It Works

1. **Commands declare** which primitives they need (in frontmatter)
2. **`sdlc.yml` configures** which values to use
3. **Claude reads** the primitive file and follows its guidance

## Dealbrain Primitives

```
primitives/
├── language/
│   └── typescript.md    ← Biome, Vitest/Jest, strict mode
├── quality/
│   ├── strict.md        ← All gates (default for PRs)
│   └── fast.md          ← Minimal gates (spikes/prototypes)
├── commit/
│   └── conventional.md  ← feat/fix/refactor/chore format
└── task-management/
    └── github.md        ← GitHub Issues + gh CLI
```

## Configuration

Set in `.claude/sdlc.yml`:

```yaml
language: typescript
task_management: github
quality_profile: strict
commit_style: conventional
```

## How Commands Use Primitives

Commands declare primitives in frontmatter:

```yaml
---
primitives:
  required:
    - language        # Must be configured
  optional:
    - quality_profile # Nice to have
---
```

When the command runs, Claude:
1. Resolves the primitive value from `sdlc.yml` (e.g., `language: typescript`)
2. Reads the primitive file (e.g., `primitives/language/typescript.md`)
3. Follows the guidance in that file during execution
