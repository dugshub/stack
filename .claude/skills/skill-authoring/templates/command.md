# Command Template

Use this template when creating a new **Command** - a workflow that users explicitly trigger with `/<name>`.

---

```markdown
---
description: {Brief description shown in /help}
argument-hint: {Expected arguments, e.g., [issue-id] or [description...]}
allowed-tools: {Tools allowed during this workflow}
primitives:
  required:
    - {primitive}     # {Why required}
  optional:
    - {primitive}     # {What it affects}
model: {Optional. Specific model for this command.}
---

# {Command Title}

## Purpose

{One paragraph: What this workflow accomplishes end-to-end.}

## Usage

```
/{command-name} {arguments}
```

**Arguments**:
- `$1` / `$ARGUMENTS`: {What the user provides}

## Dependencies

This command uses:

| Component | Type | Purpose |
|-----------|------|---------|
| `{name}` | skill/agent | {What it does in this workflow} |

## Steps

### Step 1: {Step Name}

**Delegate to**: `{agent-name}` agent

**Mission**:
- **Objective**: {What to accomplish}
- **Input**: {Data/artifacts being passed}
- **Context**: {Relevant information for this step}
- **Constraints**: {Boundaries for this step}
- **Output**: {Expected deliverable}

### Step 2: {Step Name}

**Human Gate**: {What needs approval before this step}

**Delegate to**: `{agent-name}` agent

**Mission**:
- **Objective**: {What to accomplish}
- **Input**: {Data/artifacts being passed}
- **Context**: {Relevant information for this step}
- **Constraints**: {Boundaries for this step}
- **Output**: {Expected deliverable}

### Step 3: {Step Name}

{Continue pattern...}

## Human Gates

| After Step | Gate | Approval Criteria |
|------------|------|-------------------|
| {step} | {gate name} | {What human checks before approving} |

## Output

{What this command produces when complete}

## Error Handling

{What happens if a step fails}
```

---

## Template Notes

### Arguments

Choose the right pattern:

```yaml
# Freeform - user describes something
argument-hint: [description...]
# In prompt: $ARGUMENTS

# Structured - user provides specific values
argument-hint: [issue-id] [priority]
# In prompt: $1, $2

# Mixed - one required, rest freeform
argument-hint: [issue-id] [notes...]
# In prompt: $1 for ID, $ARGUMENTS for everything
```

### Dependencies (Critical)

Explicitly list what this command uses. This helps Claude understand the orchestration:

```markdown
## Dependencies

This command uses:

| Component | Type | Purpose |
|-----------|------|---------|
| `decomposer` | agent | Breaks requirements into issues |
| `strategist` | agent | Generates implementation strategy |
| `task-management` | skill | Updates issue status and labels |
| `git-workflow` | skill | Creates branches and commits |
```

### Steps

Commands use **Mission** format for each step. Steps can be:
- **Direct execution** - Claude follows the mission directly
- **Delegation** - Claude spawns an agent with the mission

Mission format works for both - makes extraction to agents easy later:

```markdown
### Step 1: Decompose

**Delegate to**: `decomposer` agent

**Mission**:
- **Objective**: Break requirements into atomic issues
- **Input**: User's requirements ($ARGUMENTS)
- **Context**: Stack and task_management from @.claude/sdlc.yml
- **Constraints**: Max 8 sub-issues per epic, each 1-2 days of work
- **Output**: YAML issue plan with epics and sub-issues
```

**NOT** this (too detailed - that belongs in the agent):

```markdown
### Step 1: Decompose

1. Read the requirements
2. Identify the main components
3. Break into sub-tasks
4. Estimate complexity
5. Generate YAML...
```

### Human Gates

Make approval points explicit:

```markdown
## Human Gates

| After Step | Gate | Approval Criteria |
|------------|------|-------------------|
| Decompose | Issue Plan Review | Are these the right work items? |
| Strategize | Strategy Review | Is this the right approach? |
| Implement | Code Review | Does the code match the spec? |
```

### Primitives

Declare primitives in frontmatter. Resolved from (in order):
1. Issue labels (e.g., `stack:backend` → `language: python`)
2. Project config (`.claude/sdlc.yml`)
3. Defaults

```yaml
primitives:
  required:
    - language        # Must be known before execution
    - quality_profile # Determines gates to run
  optional:
    - commit_style    # Falls back to freeform if not set
```

Available primitives: `language`, `task_management`, `quality_profile`, `commit_style`

Primitive instructions live in `primitives/<category>/<value>.md`
