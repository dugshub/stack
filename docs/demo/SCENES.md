# Demo Scenes

Storyboard for README GIF recordings. Recorded with [VHS](https://github.com/charmbracelet/vhs) against the [todo](https://github.com/dugshub/todo) demo repo.

---

## Scene 1: "The Hook" (hero)

> First impression. Shows the full loop in ~15s. This is the one people see before deciding to scroll.

```
$ st create backend -d schema
$ echo "..." > src/db/schema.ts && git add -A && git commit -m "add schema"
$ st insert --after 1 -d api-routes
$ echo "..." > src/api/routes.ts && git add -A && git commit -m "add routes"
$ st submit
  [watch PRs get created in rapid fire]
$ st
  [graph appears — two branches, two PRs, clean]
```

**Beat:** create → code → submit → done. The "oh that's fast" moment.

---

## Scene 2: "The Dashboard" (graph section)

> Animated version of the full graph. Uses the staged todo repo with 5 stacks.

```
$ st
  [full graph renders — 5 stacks, dependent chains, mixed states]
  [hold 2 seconds so people can read it]
$ st -i
  [interactive mode — arrow down through branches, PR status updates as you move]
  [select one, hit enter, switches to it]
```

**Beat:** "I can see everything at a glance."

---

## Scene 3: "The Restack" (restack section)

> The most confusing concept for stacking newcomers. Visual makes it click.

```
$ st
  [show backend stack — 4 branches]
$ st 2
  [jump to branch 2]
$ echo "fix" >> src/api/routes.ts && git add -A
$ st modify -a
  [watch restack cascade: "Restacking 3-auth-middleware... ✓", "Restacking 4-rate-limiting... ✓"]
$ st
  [graph unchanged — everything clean]
```

**Beat:** "Edit anywhere, everything stays in sync."

**Requires:** Real files on backend branches (not empty commits).

---

## Scene 4: "The Merge" (merge section)

> The payoff. This is why you stack. Uses the testing stack (3 PRs, ready for review).

```
$ st merge --all
  [auto-merge enabled on #8]
  [#8 merges... retarget #9... auto-merge #9...]
  [#9 merges... retarget #10... auto-merge #10...]
  [#10 merges... stack complete]
$ st sync
  [removes merged branches, clean state]
$ st
  [testing stack gone — clean graph]
```

**Beat:** "Walk away. Come back to a clean trunk."

**Note:** Speed up the waiting parts in post. Hardest scene to record — real merge timing.

---

## Scene 5: "The Absorb" (absorb section)

> The "how did it know?" moment.

```
$ st
  [show backend stack, on branch 1]
$ echo "..." >> src/db/schema.ts
$ echo "..." >> src/api/routes.ts
$ echo "..." >> src/middleware/auth.ts
$ git add -A
$ st absorb
  schema.ts    → 1-schema          (owner match)
  routes.ts    → 2-api-routes      (owner match)
  auth.ts      → 3-auth-middleware  (owner match)
  ✓ Absorbed 3 files across 3 branches
```

**Beat:** "It knows where your changes belong."

**Requires:** Real files on backend branches (not empty commits).

---

## Scene 6: "The Undo" (undo section)

> The safety net. Quick and satisfying.

```
$ st
  [show clean graph]
$ st restack
  [conflict! something goes wrong]
  CONFLICT in src/api/routes.ts
$ st abort
$ st undo
  ✓ Restored state from before restack
$ st
  [same clean graph as before — everything back]
```

**Beat:** "Every command is reversible."

---

## Recording Notes

- **Priorities:** Scenes 1 and 2 are must-haves. Scene 3 is high value. Scene 4 is wow factor. Scenes 5 and 6 are nice-to-haves.
- **Scenes 3 and 5** need real code on branches — add files before recording.
- **Scene 4** involves real GitHub merge timing — may need to speed up or fake.
- Target 10-15 seconds per scene, tight editing.
- Use a clean terminal theme with good contrast.
