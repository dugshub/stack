# stack push

Add the current branch to the active stack.

## Usage

```bash
stack push [--stack <name>]
```

## Flags

- `--stack, -s` — Specify which stack to push to (when ambiguous)

## What it does

1. Finds the active stack from your current branch
2. Verifies the branch isn't already tracked
3. Confirms your branch descends from the stack's top
4. Appends it to the stack

## Example

```bash
git checkout -b dugshub/my-stack/2-add-api
# ... make changes, commit ...
stack push
```
