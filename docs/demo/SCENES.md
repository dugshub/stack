# Demo Scenes

Three hero demos for the README, recorded with [VHS](https://github.com/charmbracelet/vhs) against [dugshub/todo](https://github.com/dugshub/todo).

---

## Scene 1: "Retrofit" (current)

> Already have branches? Stack them in one command.

```
st create backend backend/1-schema backend/2-api backend/3-auth
st submit
st graph
```

**Setup:** Pre-creates 3 branches with real code. Tape adopts them.
**Files:** `setup-scene1.sh`, `scene1.tape`

---

## Scene 2: "Build as you go"

> Start from scratch. Create, code, grow the stack.

```
st create backend -d schema
  [work, commit]
st insert --after 1 -d api
  [work, commit]
st insert --after 2 -d auth
  [work, commit]
st submit
st graph
```

**Setup:** Clean repo, no branches. Tape creates everything.
**Files:** `setup-scene2.sh`, `scene2.tape`

---

## Scene 3: "The DAG"

> Edit anywhere. Everything stays in sync — even across dependent stacks.

Shows a pre-built multi-stack DAG:
- `backend` (3 branches, PRs)
- `caching` (2 branches, depends on backend)
- `frontend` (3 branches, PRs)
- `testing` (2 branches, PRs)

Then edits branch 2 of backend, runs `st modify -a`, and the restack cascades through backend AND into the dependent caching stack.

```
st graph                    [show the full DAG]
st down                     [move to branch 2]
  [edit a file]
st modify -a                [amend + cascade restack]
st graph                    [everything still clean]
```

**Setup:** Pre-creates 4 stacks with branches, code, and PRs. One stack depends on another.
**Files:** `setup-scene3.sh`, `scene3.tape`

---

## Recording

```bash
bash docs/demo/setup-sceneN.sh && vhs docs/demo/sceneN.tape
open -a Safari docs/demo/sceneN.gif
```

## Notes

- All hidden plumbing uses `&>/dev/null` to suppress output
- Branch names are short (`backend/1-schema` not `dugshub/backend/1-schema`)
- Setup scripts close existing PRs and clean all state before each recording
- Global `st` must be up to date: `st update`
