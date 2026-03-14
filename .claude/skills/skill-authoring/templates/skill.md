# Skill Template

Use this template when creating a new **Skill** - a capability that Claude auto-invokes based on context.

---

```markdown
---
name: {skill-name}
description: {When Claude should use this. Be specific - include trigger words users might say. Max 1024 chars.}
allowed-tools: {Tools this skill can use without permission prompts. Comma-separated.}
model: {Optional. Specific model: sonnet, opus, haiku}
---

# {Skill Title}

## Purpose

{One paragraph: What this skill does and why it exists.}

## Configuration

Read project config from @.claude/sdlc.yml for primitives.

## Primitives

| Primitive | Required | Purpose |
|-----------|----------|---------|
| `{name}` | {yes/no} | {Why this skill needs it} |

Based on primitives, read the appropriate files from `.claude/primitives/`.

## Instructions

{Step-by-step how to execute this capability. Be specific and actionable.}

1. {First step}
2. {Second step}
3. {Third step}

## Output

{What this skill produces. Be explicit about format/structure.}

## Examples

### Example 1: {Scenario}

Input: {What triggered this skill}

Action: {What the skill does}

Output: {What was produced}
```

---

## Template Notes

### Description (Critical)

The `description` determines when Claude uses this skill. Make it specific:

```yaml
# Too vague - won't trigger reliably
description: Helps with code quality

# Good - specific trigger words
description: Run code quality gates including format, lint, typecheck, and tests. Use when checking code quality, validating changes, or before commits.
```

### Allowed Tools

Be intentional. Only include tools the skill genuinely needs:

```yaml
# Read-only skill
allowed-tools: Read, Glob, Grep

# Can modify files
allowed-tools: Read, Write, Edit, Bash

# Full access (use sparingly)
allowed-tools: Read, Write, Edit, Bash, Task
```

### Primitives Section

Declare what context this skill needs to function:

```markdown
## Primitives

| Primitive | Required | Purpose |
|-----------|----------|---------|
| `language` | yes | Determines which quality tools to run |
| `quality_profile` | no | Defaults to 'strict' if not set |
```

### Instructions

Be specific and actionable. The skill IS the execution:

```markdown
## Instructions

1. Read the project's `language` primitive from config
2. Based on language, determine the quality toolchain:
   - Python: `uv run ruff format`, `uv run ruff check`, `uv run pyright`, `uv run pytest`
   - TypeScript: `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`
3. Run each gate in sequence
4. If any gate fails, stop and report the failure
5. If all gates pass, report success with summary
```
