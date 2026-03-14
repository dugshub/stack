# Stack JSON Schema

Stack state is persisted at `~/.claude/stacks/<repo-name>.json` where `<repo-name>` is the basename of the git repo directory (e.g., `dealbrain`).

## Schema

```json
{
  "repo": "owner/repo-name",
  "stacks": {
    "<stack-name>": {
      "trunk": "main",
      "branches": [
        {
          "name": "user/stack-name/1-description",
          "tip": "abc1234def5678",
          "pr": 101
        },
        {
          "name": "user/stack-name/2-description",
          "tip": "def5678abc1234",
          "pr": 102
        }
      ],
      "created": "2026-03-13T10:00:00Z",
      "updated": "2026-03-13T14:30:00Z",
      "restackState": null
    }
  }
}
```

## Fields

### Root
| Field | Type | Description |
|-------|------|-------------|
| `repo` | string | GitHub `owner/name` identifier |
| `stacks` | object | Map of stack name to stack definition |

### Stack
| Field | Type | Description |
|-------|------|-------------|
| `trunk` | string | Base branch (usually `main`) |
| `branches` | array | Ordered list of branches, index 0 is closest to trunk |
| `created` | string | ISO 8601 creation timestamp |
| `updated` | string | ISO 8601 last-modified timestamp |
| `restackState` | object/null | Present only during an interrupted restack |

### Branch
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Full branch name |
| `tip` | string/null | Commit SHA at last known state. Used for `--onto` during restack. Null if branch just created. |
| `pr` | number/null | GitHub PR number. Null if no PR created yet. |

### Restack State (temporary)
| Field | Type | Description |
|-------|------|-------------|
| `fromIndex` | number | Index of the branch that was modified (restack starts after this) |
| `currentIndex` | number | Index of the branch where conflict occurred |
| `oldTips` | object | Map of branch name to old tip SHA (before restack began) |

## Branch Naming Convention

Suggested format: `<username>/<stack-name>/<n>-<description>`

| Part | Example | Description |
|------|---------|-------------|
| `<username>` | `doug` | Developer's preferred prefix |
| `<stack-name>` | `frozen-column` | Shared across all branches in the stack |
| `<n>` | `1`, `2`, `3` | 1-indexed position in stack |
| `<description>` | `sticky-header` | Kebab-case description of the change |

Full example: `doug/frozen-column/1-sticky-header`

For retroactive adds of existing branches, the convention is suggested but not enforced.

## Active Stack Detection

The active stack is NOT stored in the JSON. It is inferred at runtime:
1. Run `git branch --show-current` to get the current branch
2. Search all stacks for a branch entry matching the current branch name
3. If found, that stack is active; the branch's index is the current position

## Storage Location

The JSON file lives at `~/.claude/stacks/<repo-basename>.json`:
- Survives branch switches (not in working tree)
- Session-independent (not in `.claude/projects/`)
- No repo noise (not committed)
- Accessible from all worktrees (shared filesystem)

## Reading and Writing

Always use atomic read-modify-write:
1. Read the JSON file (create with `{"repo": "...", "stacks": {}}` if missing)
2. Modify in memory
3. Write the entire file back
4. Update the `updated` timestamp on any modified stack
