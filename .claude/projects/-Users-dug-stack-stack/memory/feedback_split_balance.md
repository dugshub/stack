---
name: split-balance-feedback
description: When using stack split, check that branch sizes are balanced — no single branch should be 2x+ the median
type: feedback
---

When proposing or reviewing a `stack split`, always check the +/- stats for balance. If any branch is 2x+ the median size of the others, suggest breaking it up further by dependency layer, file type, or logical grouping.

**Why:** User found a 1007-line server-core branch alongside 3 branches under 200 lines each. The automatic split was "weak" — functional but not reviewable. Breaking it into types→engine→HTTP layers produced a much better distribution.

**How to apply:** After any `stack split --dry-run`, scan the stats. If imbalanced, suggest splitting the largest bucket and re-running. The iterate loop (dry-run → adjust → dry-run) should be fast — 2-3 iterations max.
