---
name: stack split improvement roadmap
description: Planned improvements for stack split — brace expansion, auto-balance suggestions, tryRun trim fix, untracked file stats, hunk-level splitting, interactive mode
type: project
---

Prioritized improvements for `stack split`:

**Phase 1 (small, high impact):**
1. **Brace expansion in patterns** — support `src/server/{types,state,clone}.ts` syntax. ~20 lines in parseSplitArgs.
2. **Auto-suggest balanced splits** — in `--dry-run`, if any entry is >2x median, suggest sub-splits grouped by subdirectory then file size. ~50 lines in renderPlan.
3. **Fix tryRun().trim() footgun** — trimming corrupts porcelain output where leading whitespace matters. Add `tryRunRaw()` variant or stop trimming (audit callers).

**Phase 2:**
4. **diffNumstat for untracked files** — use `git diff --numstat --no-index /dev/null <file>` instead of readFileSync fallback. Unifies stats path.

**Phase 3 (v2):**
5. **Hunk-level splitting** — `/regex/` pattern syntax + `git apply --cached`. Key challenge: hunk offset recomputation when excluding hunks.
6. **Interactive mode** — `stack split --interactive` TUI with file/hunk tagging and live preview.

**Why:** Current split UX requires verbose file listing and manual balancing. These improvements reduce friction significantly.
**How to apply:** When working on split, prioritize phase 1 items. Reference this when planning split work.
