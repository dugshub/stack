/**
 * Adopt the remote version of a stack's branches over local ones.
 *
 * The daemon restacks stack branches and force-pushes them, making `origin/*`
 * the source of truth. A stale local checkout that then runs `st sync` would
 * rebase its *stale local commits* onto trunk, duplicating or conflicting with
 * the rebase the daemon already performed. This module adopts `origin/<branch>`
 * over the local ref whenever it is safe (no un-pushed local work), so
 * subsequent restacks compute correct ranges.
 *
 * Shared by `st get` (explicit) and `st sync` (silent pre-pass). Assumes
 * `git fetch` already ran.
 *
 * ## Safety predicate (per branch, evaluated in order)
 *
 *   0. no `origin/<br>` ref                              → `no-remote`  (skip)
 *   1. `<br>` == `origin/<br>`                           → `in-sync`    (nothing)
 *   2. local is ancestor of remote (fast-forward)        → `behind`     (adopt)
 *   3. diverged, `git cherry` shows no `+` lines         → `rewritten`  (adopt)
 *   4. diverged with `+` lines (real local-only patches) → `diverged`   (skip / --force)
 *
 * `git cherry` is called ONLY after the case-2 ancestry check fails — on a pure
 * fast-forward its empty output is ambiguous, so reordering would be a bug.
 *
 * ## v1 limitation — join branches
 *
 * Join branches (`branch.parentTips != null`) are exempt from ALL parentTip
 * recomputation (both the `parentTips` map and the singular `parentTip`). Their
 * `parentTip` is the *primary* parent's tip, which positional `merge-base` does
 * not express. Leaving them stale is safe: `rebaseBranch`'s `isAncestor` guard
 * falls back to merge-base. They are still adopted as refs (cherry skips the
 * re-created merge commit, classifying them `rewritten`).
 */

import * as git from './git.js';
import { saveState, stackParents } from './state.js';
import { theme } from './theme.js';
import type { Stack, StackFile } from './types.js';
import * as ui from './ui.js';

export type AdoptClass =
  | 'no-remote'
  | 'in-sync'
  | 'behind'
  | 'rewritten'
  | 'diverged'
  | 'worktree-dirty';

export interface AdoptResult {
  branch: string;
  classification: AdoptClass;
  adopted: boolean;
  /** Name of the stack this branch belongs to (set by adoptStackChain). */
  stack?: string;
  /** Whether this branch's stack is the resolved (last) stack vs an ancestor. */
  resolved?: boolean;
}

export interface AdoptOptions {
  force?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  /** Branch to never adopt (classified worktree-dirty) — set by callers when
   *  the session started dirty, since the wrapper's auto-stash pops AFTER any
   *  reset. Not overridden by force. */
  protectBranch?: string;
  /** Stack name appended as `(stack <name>)` to per-branch adoption lines so
   *  output is attributable when adopting more than one stack (ancestor walk).
   *  Omitted for the resolved stack. */
  attribution?: string;
}

/** Classify whether it is safe to adopt `origin/<branch>` over local `<branch>`. */
function classify(
  branch: string,
  opts: AdoptOptions,
): Exclude<AdoptClass, 'worktree-dirty'> | 'worktree-dirty' {
  if (!git.hasRemoteRef(branch)) return 'no-remote';

  const localRes = git.tryRun('rev-parse', branch);
  const remoteRes = git.tryRun('rev-parse', `origin/${branch}`);
  if (!localRes.ok || !remoteRes.ok) return 'no-remote';
  const local = localRes.stdout;
  const remote = remoteRes.stdout;

  if (local === remote) return 'in-sync';

  // Case 2: local is an ancestor of remote — pure fast-forward, zero risk.
  if (git.isAncestor(local, `origin/${branch}`)) return 'behind';

  // Case 3/4: diverged. Run cherry ONLY now (after the ancestry check failed).
  // `+` lines are local-only commits with no patch-equivalent on the remote.
  const marks = git.cherry(`origin/${branch}`, branch);
  // Empty array also covers a failed cherry run → fail safe to diverged unless
  // every listed commit is patch-equivalent (none with `+`).
  const hasLocalOnly = marks.length === 0 || marks.some((m) => !m.equivalent);
  return hasLocalOnly ? 'diverged' : 'rewritten';
}

/**
 * Adopt `origin/<branch>` for the given branch. Updates the local ref / working
 * tree per worktree placement. Returns true on success.
 */
function performAdoption(
  branch: string,
  worktreeMap: Map<string, string>,
  currentRoot: string,
): boolean {
  const target = `origin/${branch}`;
  const worktreePath = worktreeMap.get(branch);

  if (worktreePath && worktreePath === currentRoot) {
    // Checked out in the CURRENT worktree (= the current branch): reset in place.
    const res = git.tryRun('reset', '--hard', target);
    return res.ok;
  }

  if (!worktreePath) {
    // Not checked out anywhere: ref-only update, never touches a working tree.
    const res = git.tryRun('branch', '-f', branch, target);
    return res.ok;
  }

  // Checked out in ANOTHER worktree.
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '-uno'], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: worktreePath,
  });
  const dirty = status.stdout.toString().trim().length > 0;
  if (dirty) return false; // caller already classified worktree-dirty
  const reset = Bun.spawnSync(['git', 'reset', '--hard', target], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: worktreePath,
  });
  return reset.exitCode === 0;
}

/**
 * Adopt remote branch refs for a stack. Assumes `git fetch` already ran.
 * Mutates branch tips/parentTips in `stack`, saves state when anything changed
 * (not in dryRun). Emits ui.info/success per adopted branch unless quiet. Never
 * throws on per-branch failures.
 */
export function adoptRemoteBranches(
  state: StackFile,
  stack: Stack,
  opts: AdoptOptions = {},
): AdoptResult[] {
  const { force = false, dryRun = false, quiet = false, protectBranch, attribution } = opts;
  const worktreeMap = git.worktreeList();
  const currentRoot = git.repoRoot();
  const suffix = attribution ? ` ${theme.muted(`(stack ${attribution})`)}` : '';

  const results: AdoptResult[] = [];
  let changed = false;

  for (const branch of stack.branches) {
    let cls: AdoptClass = classify(branch.name, opts);

    // protectBranch is the dirty current branch: never adopt it, even under
    // --force. Adopting would reset under the about-to-be-popped auto-stash.
    if (branch.name === protectBranch && (cls === 'behind' || cls === 'rewritten' || cls === 'diverged')) {
      cls = 'worktree-dirty';
    }

    // A branch checked out dirty in ANOTHER worktree can't be safely reset.
    if (cls === 'behind' || cls === 'rewritten' || (cls === 'diverged' && force)) {
      const worktreePath = worktreeMap.get(branch.name);
      if (worktreePath && worktreePath !== currentRoot) {
        const status = Bun.spawnSync(['git', 'status', '--porcelain', '-uno'], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: worktreePath,
        });
        if (status.stdout.toString().trim().length > 0) cls = 'worktree-dirty';
      }
    }

    const shouldAdopt =
      cls === 'behind' || cls === 'rewritten' || (cls === 'diverged' && force);

    let adopted = false;
    if (shouldAdopt && !dryRun) {
      adopted = performAdoption(branch.name, worktreeMap, currentRoot);
      if (adopted) {
        branch.tip = git.revParse(branch.name);
        changed = true;
        if (!quiet) {
          ui.success(`↓ adopted ${theme.branch(`origin/${branch.name}`)}${suffix}`);
        }
      } else if (!quiet) {
        ui.error(`Failed to adopt origin/${branch.name}${suffix}`);
      }
    } else if (shouldAdopt && dryRun) {
      // Report what would happen.
      if (!quiet) {
        ui.info(`would adopt ${theme.branch(`origin/${branch.name}`)} (${cls})${suffix}`);
      }
    }

    results.push({ branch: branch.name, classification: cls, adopted });
  }

  // Recompute parentTip for all NON-JOIN branches (an adopted parent shifts a
  // child's fork point even if the child was in-sync). Join branches are exempt.
  if (changed && !dryRun) {
    // For index 0, prefer the freshly-fetched remote trunk ref when it exists:
    // the local trunk branch may be stale (sync does not fast-forward it before
    // this pass), and an adopted child's fork point is defined against the
    // *current* trunk. This makes a fully-daemon-restacked stack's parentTip
    // equal origin/<trunk>, so sync's trunkMoved check reads false.
    const trunkRef = git.hasRemoteRef(stack.trunk)
      ? `origin/${stack.trunk}`
      : stack.trunk;
    for (let i = 0; i < stack.branches.length; i++) {
      const branch = stack.branches[i];
      if (!branch) continue;
      if (branch.parentTips != null) continue; // join branch — leave both fields
      const parentRef = i === 0 ? trunkRef : stack.branches[i - 1]?.name;
      if (!parentRef) continue;
      const mb = git.tryRun('merge-base', parentRef, branch.name);
      if (mb.ok) branch.parentTip = mb.stdout;
    }
    stack.updated = new Date().toISOString();
    saveState(state);
  }

  return results;
}

/**
 * Collect a stack's ancestor stack names (transitive parents) in root-down
 * topological order — i.e. the root-most ancestor first, the resolved stack's
 * immediate parent last. The resolved stack itself is NOT included. Diamonds
 * (multiple parents) and cycles are guarded by a visited set, matching
 * `cascadeDependentStacks`.
 */
export function collectAncestorStacks(
  state: StackFile,
  resolvedName: string,
): string[] {
  const order: string[] = [];
  const visited = new Set<string>([resolvedName]);

  // Post-order DFS over parents yields root-most first.
  const visit = (name: string): void => {
    const stack = state.stacks[name];
    if (!stack) return;
    for (const parent of stackParents(stack)) {
      if (visited.has(parent.stack)) continue;
      visited.add(parent.stack);
      visit(parent.stack);
      order.push(parent.stack);
    }
  };
  visit(resolvedName);
  return order;
}

/**
 * Walk the dependency chain upward and adopt each ancestor stack before the
 * resolved stack (root-down order, resolved last). Assumes `git fetch` already
 * ran.
 *
 * Rules (per the spec addendum):
 * - `--force` (opts.force) applies ONLY to the resolved stack. Ancestor stacks
 *   always adopt with `force: false` (risk-free classes only); their `diverged`
 *   branches are reported with `st get -s <ancestor> --force` as the hint by the
 *   calling command.
 * - `protectBranch` applies to every stack's pass (the current branch may live
 *   in an ancestor).
 * - Ancestor stacks with a non-null `restackState` are warned and skipped
 *   (does NOT abort the resolved stack's run).
 * - Per-branch adoption lines carry a `(stack <name>)` attribution for any
 *   non-resolved stack.
 *
 * Returns a flat list of results across every adopted stack, each tagged with
 * `stack` and `resolved`. Downstream dependent stacks are out of scope.
 */
export function adoptStackChain(
  state: StackFile,
  resolvedName: string,
  opts: AdoptOptions = {},
): AdoptResult[] {
  const { force = false, dryRun = false, quiet = false, protectBranch } = opts;
  const all: AdoptResult[] = [];

  const ancestors = collectAncestorStacks(state, resolvedName);
  for (const name of ancestors) {
    const stack = state.stacks[name];
    if (!stack) continue;
    if (stack.restackState != null) {
      if (!quiet) {
        ui.warn(
          `Skipping ancestor stack ${theme.stack(name)} — a restack is in progress there.`,
        );
      }
      continue;
    }
    const results = adoptRemoteBranches(state, stack, {
      force: false, // never force ancestors
      dryRun,
      quiet,
      protectBranch,
      attribution: name,
    });
    for (const r of results) {
      r.stack = name;
      r.resolved = false;
    }
    all.push(...results);
  }

  // Resolved stack last — force applies only here.
  const resolved = state.stacks[resolvedName];
  if (resolved) {
    const results = adoptRemoteBranches(state, resolved, {
      force,
      dryRun,
      quiet,
      protectBranch,
    });
    for (const r of results) {
      r.stack = resolvedName;
      r.resolved = true;
    }
    all.push(...results);
  }

  return all;
}
