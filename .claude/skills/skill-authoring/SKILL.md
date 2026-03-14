---
name: skill-authoring
description: Create Claude Code skills, commands, and agents following SDLC standards. Use when asked to create new skills, define workflows, or set up agents for the project.
allowed-tools: Read, Write, Glob, Grep
user-invocable: true
---

# Skill Authoring

Create Claude Code components (skills, commands, agents) following our SDLC architecture.

## Three Component Types

| Type | Location | Invocation | Purpose |
|------|----------|------------|---------|
| **Skill** | `skills/<name>/SKILL.md` | Claude auto-invokes | Single capability |
| **Command** | `commands/<name>.md` | User types `/<name>` | Workflow orchestration |
| **Agent** | `agents/<name>.md` | Claude delegates | Isolated specialist |

## When to Create Each

**Create a Skill when**:
- Claude should automatically use it based on context
- It's a single, thematic capability
- It needs to be reusable across workflows

**Create a Command when**:
- User should explicitly trigger it
- It orchestrates multiple skills/agents
- It has distinct steps with human gates

**Create an Agent when**:
- Task needs isolated context (won't pollute main conversation)
- Task is a specialty (decomposition, strategy, coding, review)
- Task needs restricted tool access for safety

## Primitives

Components can declare primitives they need. These are resolved from:
1. Command arguments
2. Issue labels (e.g., `stack:backend`)
3. Project config (`.claude/sdlc.yml`)

Common primitives:
- `language`: python, typescript, go
- `task_management`: linear, github, jira
- `quality_profile`: strict, fast
- `commit_style`: conventional, freeform

## Templates

Use these templates when creating components:

- **Skill**: @templates/skill.md
- **Command**: @templates/command.md
- **Agent**: @templates/agent.md

## Creating a New Component

1. **Determine the type** - skill, command, or agent?
2. **Read the appropriate template** from this skill's templates/
3. **Fill in the template** with specific details
4. **Place in correct location**:
   - Skills: `.claude/skills/<name>/SKILL.md`
   - Commands: `.claude/commands/<name>.md`
   - Agents: `.claude/agents/<name>.md`

## Naming Conventions

- Use lowercase with hyphens: `task-management`, `quality-gates`
- Be specific but concise
- Skills: noun or noun-phrase (what it is)
- Commands: verb or verb-phrase (what user wants to do)
- Agents: role name (who it is)

## Key Principles

1. **Skills are thematic** - group by what they do, not by tool
2. **Commands delegate** - orchestrate, don't implement
3. **Agents are focused** - one specialty, limited tools
4. **Explicit > implicit** - declare dependencies, primitives, gates
