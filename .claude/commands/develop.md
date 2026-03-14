---
description: Full SDLC loop from idea to merged code
argument-hint: [idea or issue-id] [--yolo]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, WebFetch, WebSearch
primitives:
  required:
    - language          # Determines implementation patterns
    - task_management   # Where issues live (system-specific behavior)
    - session-logging   # Execution journal and audit trail
  optional:
    - quality_profile   # strict or fast validation
    - commit_style      # conventional or freeform
---

# /develop

Run the full SDLC loop: Understand → Plan → Spec → Implement → Validate.

Each loop has a human gate unless `--yolo` is passed — in which case all gates are auto-approved and the full loop runs end-to-end without stopping. Sessions are logged for audit trail and resume capability.

## Usage

```
/develop Add keyboard shortcuts to the app     # Full loop from idea
/develop {ISSUE-ID}                            # Resume from existing issue
/develop --from=spec {ISSUE-ID}                # Jump to spec phase
/develop --resume                              # Resume most recent session
/develop --resume {session-id}                 # Resume specific session
/develop --no-logging                          # Disable session logging
/develop --yolo Add keyboard shortcuts         # Skip all human gates, run end-to-end
```

## Input Detection

Determine what was provided:

1. **Issue ID** (e.g., `{ISSUE-ID}`):
   - Fetch issue from configured task tracker (see `task_management` primitive)
   - Check for existing spec in `.claude/specs/`
   - Resume from appropriate phase

2. **Free text**:
   - Start from understanding phase
   - Full loop

3. **`--from=` flag**:
   - `--from=understand` - Start fresh
   - `--from=plan` - Skip to planning (assumes understanding exists)
   - `--from=spec` - Skip to specification
   - `--from=implement` - Skip to implementation
   - `--from=validate` - Skip to validation

4. **`--yolo` flag**:
   - All human gates are auto-approved
   - Runs the entire loop end-to-end without stopping
   - Combinable with other flags (e.g., `--yolo --from=spec`)
   - Session logging still active (use `--no-logging` to disable both)

## The Loops

```
+---------------------------------------------------------------------------+
|                                                                           |
|  +-----------+    +--------+    +------+    +-----------+    +--------+   |
|  | UNDERSTAND|--->|  PLAN  |--->| SPEC |--->| IMPLEMENT |--->|VALIDATE|   |
|  +-----+-----+    +---+----+    +--+---+    +-----+-----+    +---+----+   |
|        |              |            |              |              |        |
|        v              v            v              |              v        |
|   [Human Gate]   [Human Gate] [Human Gate]       |        [Human Gate]   |
|   "Got it?"      "Right        "Right            |        "Merge?"       |
|                   breakdown?"   approach?"       |                       |
|                                                  |                       |
|   --yolo: all human gates auto-approved -------->|                       |
|                                                  |                       |
|                              +-------------------+                       |
|                              | (agentic - no gate)                       |
|                              v                                           |
|                    Parallel execution for subtasks                       |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## Phase 1: Understand

**Delegate to:** `understander` agent

**Mission:**
- **Objective:** Demonstrate working knowledge of the problem, application, and systems
- **Input:** User's idea/request ($ARGUMENTS)
- **Context:** Codebase structure, existing patterns, relevant files
- **Constraints:** Don't propose solutions yet - just prove understanding
- **Output:** Understanding artifact (context tree + framing statement)

**Output Format:**
```markdown
## Understanding

{1-2 sentence restatement}

### Context
- Problem: {what's broken or missing}
- Users: {who cares}
- Systems: {what's touched}

### Relevant Code
{path}/
+-- file.ts      <- {why}
+-- file.ts      <- {why}
```

**Human Gate:** Present understanding, ask "Did I get this right?" (`--yolo`: auto-approve, proceed immediately)

**On Approval:** Proceed to Plan phase

---

## Phase 2: Plan

**Delegate to:** `planner` agent

**Mission:**
- **Objective:** Break understood concept into PR-sized issues with dependencies
- **Input:** Approved understanding artifact
- **Context:** Recent PRs (for sizing), task tracker label taxonomy, existing merge-plans
- **Constraints:**
  - Issues sized for single-PR review
  - Subtasks indicate parallel work
  - Use task tracker labels as configured in `task_management` primitive
- **Output:** Issue tree with dependencies

**Output Format:**
```markdown
## Plan

### Issue Tree
{feature}/
+-- [task] {title}                    (stack:x, layer:y)
|   +-- [subtask] {parallel work A}
|   +-- [subtask] {parallel work B}
+-- [task] {title}                    (stack:x, layer:y)
|   +-- blocks: {dependency}
+-- [task] {title}                    (stack:x)

### Dependency Graph
{task A} --+---> {task C} ---> {task D}
{task B} --+
```

**Human Gate:** Present issue tree, ask "Is this the right breakdown?" (`--yolo`: auto-approve, proceed immediately)

**On Approval:**
1. Create issues in task tracker (use `task_management` primitive for system-specific behavior)
2. Proceed to Spec phase for first unblocked issue

---

## Phase 3: Spec

**Delegate to:** `specifier` agent (one per issue)

**Mission:**
- **Objective:** Convert issue into implementation spec (pseudocode, files, API)
- **Input:** Issue title + description from task tracker
- **Context:** Understanding artifact, related specs, codebase patterns
- **Constraints:**
  - Pseudocode level - not full implementation
  - Must list all files touched (new + modified)
  - Must define interfaces/types
- **Output:** Spec file at `.claude/specs/{issue-slug}.md`

**Output Format:**
```markdown
# {Issue Title} Spec

## Overview
{What this delivers}

## Architecture
{Component relationships, data flow}

## Files
| File | Action | Purpose |
|------|--------|---------|
| path/to/file.ts | create | {why} |
| path/to/file.ts | modify | {what changes} |

## Interface
{Types, props, method signatures}

## Implementation Steps
1. {Step}
2. {Step}

## Open Questions
- {Decisions needed}
```

**Human Gate:** Present spec, ask "Is this the right approach?" (`--yolo`: auto-approve, proceed immediately)

**On Approval:** Proceed to Implement phase

**Parallelization:** If multiple issues are unblocked, spec them in parallel.

---

## Phase 4: Implement

**Delegate to:** `implementer` agent (one per issue)

**Mission:**
- **Objective:** Write code following the approved spec
- **Input:** Approved spec file
- **Context:**
  - Language primitive (typescript/python patterns)
  - Framework conventions
  - Existing codebase patterns
- **Constraints:**
  - Follow spec exactly - no scope creep
  - One commit per logical change
  - Run checks before marking complete
- **Output:** Working code on feature branch

**Execution:**
1. Create branch: `{issue-id}/{issue-slug}` (e.g., `{ISSUE-ID}/add-keyboard-shortcuts`)
2. Implement following spec steps
3. Run `bun run check` (or equivalent)
4. Commit with conventional message

**No Human Gate:** Implementation is agentic. Validation phase provides the checkpoint.

**Parallelization:** Subtasks run in parallel on separate branches. Parent issue branch merges subtask branches.

---

## Phase 5: Validate

**Delegate to:** `validator` agent

**Mission:**
- **Objective:** Prove the implementation works
- **Input:** Completed branch from implementer
- **Context:** Quality profile (strict/fast), test patterns
- **Constraints:** Must pass all gates before approval
- **Output:** Validation report

**Validation Gates:**
```
+-------------+
| Type Check  |---> pass/fail
+-------------+
| Lint        |---> pass/fail
+-------------+
| Unit Tests  |---> pass/fail + coverage
+-------------+
| Integration |---> pass/fail (if applicable)
+-------------+
| Visual      |---> Storybook/browser check (if UI)
+-------------+
```

**Output Format:**
```markdown
## Validation Report

### Gates
| Gate | Status | Notes |
|------|--------|-------|
| Type Check | OK | - |
| Lint | OK | - |
| Unit Tests | OK | 12 tests, 94% coverage |
| Visual | OK | Storybook renders correctly |

### Summary
Ready for review. All gates passed.
```

**Human Gate:** Present validation report, ask "Ready to merge?" (`--yolo`: auto-approve, create PR immediately)

**On Approval:**
1. Create PR (use commit skill patterns)
2. Update issue status in task tracker (use `task_management` primitive)

---

## Session Logging

**See:** `.claude/primitives/session-logging.md` for full specification.

Sessions are logged to `agent-logs/{session-id}/` with this structure:

```
agent-logs/develop-20240129-a3f2/
├── session.yaml           ← State + cursor for resume
├── request.md             ← Original user request
├── phases/
│   ├── 1-understand/
│   │   ├── artifact.md    ← Understanding output
│   │   └── decision.md    ← Human gate: "Did I get this right?"
│   ├── 2-plan/
│   │   ├── artifact.md    ← Issue tree
│   │   └── decision.md    ← Human gate: "Right breakdown?"
│   └── 3-execute/
│       └── {issue-id}/
│           ├── spec.md
│           ├── implement.log
│           ├── validate.md
│           └── decision.md  ← Human gate: "Ready to merge?"
├── gates/                 ← Quality gate logs
└── summary.md             ← Final summary
```

### Session Initialization

At command start (skip if `--no-logging`):

```bash
SESSION_ID="develop-$(date +%Y%m%d)-$(openssl rand -hex 2)"
SESSION_DIR="agent-logs/$SESSION_ID"
mkdir -p "$SESSION_DIR"/{phases/1-understand,phases/2-plan,phases/3-execute,gates}

# Initialize session.yaml with request, context, cursor
```

### Decision Logging

After each human gate:

```markdown
# Decision: {Phase} Gate

**Timestamp**: {ISO timestamp}
**Gate**: "Did I get this right?"
**Response**: approved | rejected | adjusted

## User Feedback
{What the user said}

## Adjustments Made
- {Changes based on feedback}
```

### Session Finalization

On completion or abandonment:

```bash
# Update session.yaml status
# Generate summary.md
# Commit session logs to git

git add agent-logs/$SESSION_ID/
git commit -m "docs(session): $SESSION_ID completed"
```

### Resume Protocol

1. `--resume` finds most recent in-progress session
2. Load `session.yaml`, read `cursor` for position
3. Continue from that phase/issue
4. Preserve all existing artifacts

---

## Error Handling

**Phase fails:**
1. Report what went wrong
2. Ask human how to proceed:
   - Retry with adjustments
   - Skip to next phase
   - Abort

**Validation fails:**
1. Report failing gates
2. Loop back to implementer with failure context
3. Max 3 retries before human intervention

**Blocked issue:**
1. Skip to next unblocked issue
2. Return when blocker completes

---

## Dependencies

This command uses:

| Component | Type | Purpose |
|-----------|------|---------|
| `understander` | agent | Demonstrates problem understanding |
| `planner` | agent | Breaks down into issues |
| `specifier` | agent | Creates implementation specs |
| `implementer` | agent | Writes code |
| `validator` | agent | Runs validation gates |
| `task_management` | primitive | System-specific issue creation/updates |
| `session-logging` | primitive | Execution journal and audit trail |
| `code-review` | skill | Optional pre-merge review |

---

## Example Flow

```
User: /develop Add keyboard shortcuts to the app

[Session: develop-20240129-a3f2]
Claude: Starting session, logging to agent-logs/develop-20240129-a3f2/

[Phase 1: Understand]
Agent: Explores codebase, produces understanding artifact
→ Logged to: phases/1-understand/artifact.md
Claude: "Here's my understanding... Did I get this right?"
User: "Yes, but also consider accessibility"
→ Logged to: phases/1-understand/decision.md (adjusted)
Claude: Updates understanding, re-confirms

[Phase 2: Plan]
Agent: Produces issue tree
→ Logged to: phases/2-plan/artifact.md
Claude: "Here's the breakdown... Is this right?"
User: "Looks good"
→ Logged to: phases/2-plan/decision.md (approved)
Claude: Creates issues in task tracker

[Phase 3: Spec - {ISSUE-ID}]
Agent: Produces spec for shortcuts registry
→ Logged to: phases/3-execute/{issue-id}/spec.md
Claude: "Here's the approach... Right direction?"
User: "Yes"
→ Logged to: phases/3-execute/{issue-id}/decision.md

[Phase 4: Implement - {ISSUE-ID}]
Agent: Implements following spec
→ Logged to: phases/3-execute/{issue-id}/implement.log
(no gate - runs autonomously)

[Phase 5: Validate - {ISSUE-ID}]
Agent: Runs all checks
→ Logged to: phases/3-execute/{issue-id}/validate.md
→ Gate logs: gates/typecheck.log, gates/lint.log, gates/test.log
Claude: "All gates passed. Ready to merge?"
User: "Yes"
Claude: Creates PR, moves to next issue

[Session Complete]
Claude: Session develop-20240129-a3f2 committed to git
→ Summary: agent-logs/develop-20240129-a3f2/summary.md

[Resume Later]
User: /develop --resume
Claude: Resuming develop-20240129-a3f2 from issue {ISSUE-ID-2}...
```
