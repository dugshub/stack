---
name: team
description: Spin up an agent team with split-panel teammates for parallel work. Use when the user says "team", "swarm", "teammates", or wants multiple agents working in parallel on review, implementation, research, or debugging tasks.
allowed-tools: Agent, TeamCreate, TeamDelete, TaskCreate, TaskList, TaskGet, TaskUpdate, SendMessage, Read, Glob, Grep, Bash(git:*)
user-invocable: true
---

# Agent Team Skill

Spin up a coordinated team of Claude Code agents working in split-panel tmux/iTerm2 panes.

## Prerequisites

Agent teams require two settings in `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" },
  "teammateMode": "tmux"
}
```

**Terminal requirements:** Split panes need tmux or iTerm2 (with `it2` CLI + Python API enabled). Does NOT work in VS Code integrated terminal, Windows Terminal, or Ghostty. The `"auto"` mode auto-detects: uses split panes inside tmux, falls back to in-process otherwise.

## How It Works

1. **TeamCreate** creates a named team + shared task list
2. **TaskCreate** populates the task list with work items
3. **Agent** with `team_name` spawns teammates into split panes
4. Teammates self-coordinate via the shared task list and messaging
5. **SendMessage** for inter-agent communication
6. **TeamDelete** cleans up when done (after all teammates shut down)

## Instructions

### 1. Parse the user's request

Determine the team structure from the user's prompt. Common patterns:

| Pattern | Teammates | Example |
|---------|-----------|---------|
| `/team review` | reviewer, lint-checker, test-runner | Review current branch changes |
| `/team build <spec>` | builder, validator | Implement from a spec file |
| `/team investigate <issue>` | 2-3 hypothesis investigators | Debug with competing theories |
| `/team research <topic>` | 2-3 researchers with different angles | Parallel exploration |

If the user provides arguments after `/team`, use them to shape the team. If no arguments, ask what they want the team to do.

### 2. Create the team

```
TeamCreate({ team_name: "<descriptive-name>" })
```

Use a short, descriptive name like `filter-review`, `auth-refactor`, `bug-hunt`.

### 3. Create tasks

Create one task per teammate with clear, self-contained descriptions. Each task should have enough context for the teammate to work independently without the lead's conversation history.

```
TaskCreate({
  subject: "Review authentication module for security issues",
  description: "Read src/auth/ and check for OWASP Top 10 vulnerabilities..."
})
```

Guidelines:
- 5-6 tasks per teammate is the sweet spot
- Include file paths and specific instructions in descriptions
- Set up task dependencies with `TaskUpdate` if needed (blocks/blockedBy)

### 4. Spawn teammates

Spawn all teammates in a single message for true parallelism:

```
Agent({
  name: "reviewer",
  team_name: "<team-name>",
  subagent_type: "<appropriate-type>",  // see agent type selection below
  run_in_background: true,
  prompt: "You are on the <team-name> team. Claim and complete tasks from the task list. <specific context>"
})
```

**Agent type selection:**
- Read-only work (review, research, exploration): use `Explore` or `general-purpose`
- Implementation work (writing code): use `general-purpose` or custom agents like `builder`
- Validation work (lint, test, verify): use `validator`
- Planning work: use `Plan`

**Custom project agents** are available in `.claude/agents/team/`:
- `builder` — implements code, runs self-checks, opus model
- `validator` — read-only review, cannot write files, opus model

### 5. Monitor and synthesize

- Teammate messages arrive automatically — no polling needed
- Teammates go idle after each turn (this is normal, not an error)
- Use `SendMessage` to redirect teammates or give follow-up instructions
- Synthesize findings as teammates report back

### 6. Shutdown and cleanup

When all work is done:

1. Send shutdown requests to all teammates:
   ```
   SendMessage({ type: "shutdown_request", recipient: "<name>", content: "Done, shutting down" })
   ```

2. Wait for all shutdown confirmations

3. Clean up the team:
   ```
   TeamDelete()
   ```

**Important:** TeamDelete fails if teammates are still active. Shut them all down first.

## Team Presets

### `/team review` — Review current branch
Spawns 3 teammates:
- **code-reviewer**: reads changed files, checks types/patterns/bugs
- **lint-checker**: runs biome + tsc, reports pass/fail
- **test-runner**: runs relevant tests

### `/team build <spec-file>` — Implement from spec
Spawns 2 teammates (builder+validator pattern):
- **builder**: reads spec, implements changes
- **validator**: reviews builder's work, runs quality gates

### `/team investigate` — Debug with hypotheses
Spawns 2-3 teammates, each exploring a different theory. They message each other to challenge findings.

### `/team research <topic>` — Parallel exploration
Spawns 2-3 researchers exploring different aspects of the topic simultaneously.

## Best Practices

- **3-5 teammates max** — more adds coordination overhead with diminishing returns
- **Independent work** — avoid assigning two teammates to the same files
- **Rich prompts** — teammates don't inherit the lead's conversation history, so include all context in the spawn prompt
- **Use custom agents** — leverage `.claude/agents/team/builder.md` and `validator.md` for implementation work
- **Require plan approval** for risky changes — spawn with `mode: "plan"` so you review before they implement

## Token Cost Warning

Agent teams use ~7x the tokens of a single session. Best for tasks where parallel exploration genuinely adds value. For sequential or simple tasks, use regular subagents instead.
