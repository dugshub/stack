# Agent Template

Use this template when creating a new **Agent** (Subagent) - an isolated specialist that Claude delegates to.

---

```markdown
---
name: {agent-name}
description: {When Claude should delegate to this agent. Be specific about the specialty.}
tools: {Allowed tools - be restrictive for safety}
model: {Optional. haiku for fast/simple, sonnet for complex, opus for critical}
permissionMode: {Optional. plan for read-only, default for normal}
---

# {Agent Role Title}

## Expertise

{One paragraph: What this agent specializes in. What makes it the right choice for this task.}

## Configuration

Read project config from @.claude/sdlc.yml for primitives.

## Primitives

| Primitive | Required | Purpose |
|-----------|----------|---------|
| `{name}` | {yes/no} | {Why this agent needs it} |

## Instructions

{Detailed instructions for how to perform this specialty. This IS the implementation.}

1. {First step}
2. {Second step}
3. {Third step}

## Output Format

{Explicit structure of what this agent produces}

```
{format example}
```

## Constraints

{What this agent should NOT do - explicit boundaries}

- Do NOT {constraint}
- Do NOT {constraint}
- ONLY {limitation}
```

---

## Template Notes

### Description (Critical)

The `description` determines when Claude delegates. Be specific about the specialty:

```yaml
# Too vague
description: Helps with code

# Good - clear specialty
description: Expert code reviewer. Analyzes code for quality, security, and best practices. Use proactively after code changes or when reviewing PRs.
```

### Tools (Be Restrictive)

Agents should have minimal tool access for their specialty:

```yaml
# Read-only analyst
tools: Read, Glob, Grep

# Can run commands but not edit
tools: Read, Glob, Grep, Bash

# Full implementation capability
tools: Read, Write, Edit, Bash, Glob, Grep
```

### Permission Mode

Use `permissionMode` for additional safety:

```yaml
# Read-only mode - can't modify anything
permissionMode: plan

# Normal mode with permission prompts
permissionMode: default

# Auto-accept edits (use carefully)
permissionMode: acceptEdits
```

### Expertise Section

Frame the agent's specialty clearly:

```markdown
## Expertise

I am a decomposition specialist. I take high-level requirements and break them into atomic, implementable work items. I understand dependency relationships, can estimate relative complexity, and structure work for parallel execution where possible.
```

### Instructions (Detailed)

Unlike commands, agents DO the work. Instructions should be thorough:

```markdown
## Instructions

1. Read the provided requirements carefully
2. Identify the major components or features
3. For each component:
   - Break into atomic tasks (1-2 hours of work each)
   - Identify dependencies between tasks
   - Assign appropriate labels (stack, layer, type)
4. Structure as YAML with:
   - Epic (parent issue)
   - Sub-issues (children)
   - Dependency relationships
5. Validate the structure is complete and coherent
```

### Output Format (Explicit)

Define exactly what the agent produces:

```markdown
## Output Format

Produce a YAML issue plan:

```yaml
epic:
  title: "{feature name}"
  description: "{high-level description}"
  labels: [epic, stack:{stack}]

issues:
  - title: "{atomic task}"
    description: "{details}"
    labels: [stack:{stack}, layer:{layer}]
    depends_on: []  # or list of issue titles
```
```

### Constraints (Important)

Explicitly limit scope to prevent drift:

```markdown
## Constraints

- Do NOT implement code - only plan and structure
- Do NOT make assumptions about technical approach - flag uncertainties
- Do NOT create more than 10 sub-issues per epic - break into multiple epics if larger
- ONLY output the YAML plan - no additional commentary unless asked
```
