import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import * as git from './git.js';
import type { Stack, StackFile, StackParent, StackPosition } from './types.js';

export function getStackDir(): string {
  return join(homedir(), '.claude', 'stacks');
}

export function getStackFilePath(): string {
  const repoName = git.repoKey();
  return join(getStackDir(), `${repoName}.json`);
}

export function loadState(): StackFile {
  const filePath = getStackFilePath();
  try {
    const text = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(text) as StackFile;
    // Ensure currentStack field exists (migration from older state files)
    if (data.currentStack === undefined) {
      data.currentStack = null;
    }
    // Migrate legacy dependsOn: { stack, branch } -> [{ stack, branch }]
    for (const stack of Object.values(data.stacks)) {
      const raw = (stack as unknown as { dependsOn?: unknown }).dependsOn;
      if (raw && !Array.isArray(raw) && typeof raw === 'object') {
        stack.dependsOn = [raw as StackParent];
      }
    }
    return data;
  } catch {
    return {
      repo: '',
      stacks: {},
      currentStack: null,
    };
  }
}

export function saveState(state: StackFile): void {
  const filePath = getStackFilePath();
  const dir = getStackDir();
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  // Always serialise dependsOn as an array. Empty arrays are dropped. The
  // read-time migration handles legacy object shape from older builds.
  const serializable: StackFile = {
    ...state,
    stacks: Object.fromEntries(
      Object.entries(state.stacks).map(([name, stack]) => {
        if (stack.dependsOn && stack.dependsOn.length === 0) {
          const { dependsOn: _ignored, ...rest } = stack;
          return [name, rest as Stack];
        }
        return [name, stack];
      }),
    ),
  };
  writeFileSync(tmpPath, `${JSON.stringify(serializable, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

export function stackParents(stack: Stack): StackParent[] {
  return stack.dependsOn ?? [];
}

export function primaryParent(stack: Stack): StackParent | undefined {
  return stack.dependsOn?.[0];
}

export function getHistoryFilePath(): string {
  const repoName = git.repoKey();
  return join(getStackDir(), `${repoName}.history.jsonl`);
}

/**
 * One-time migration for state files orphaned by the pre-0.9.8 keying scheme,
 * which keyed state by the *worktree* directory name. State written from inside
 * a git worktree landed in `<worktree-dir>.json` instead of the repo's canonical
 * file, divorced from the stacks in the main checkout.
 *
 * Now that state keys off the shared object store (`git.repoKey()`), this folds
 * any such orphan back into the canonical file. It is a no-op in the main
 * checkout (where the legacy and canonical keys are equal) and idempotent (it
 * archives the orphan once merged). Must stay safe to call on every invocation.
 */
export function migrateWorktreeState(): void {
  let canonicalKey: string;
  let legacyKey: string;
  try {
    canonicalKey = git.repoKey();
    legacyKey = basename(git.repoRoot());
  } catch {
    return;
  }
  // Main checkout: the legacy worktree-dir key already equals the canonical key.
  if (canonicalKey === legacyKey) return;

  const dir = getStackDir();
  const legacyPath = join(dir, `${legacyKey}.json`);
  if (!existsSync(legacyPath)) return;

  let legacy: StackFile;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as StackFile;
  } catch {
    return; // unreadable — leave it untouched
  }

  const canonicalPath = join(dir, `${canonicalKey}.json`);
  const canonicalExists = existsSync(canonicalPath);
  let canonical: StackFile = { repo: '', stacks: {}, currentStack: null };
  if (canonicalExists) {
    try {
      canonical = JSON.parse(readFileSync(canonicalPath, 'utf-8')) as StackFile;
    } catch {
      return;
    }
  }
  canonical.stacks ??= {};

  // Identity guard: only touch the legacy file if it belongs to *this* repo.
  // Guards against a worktree dir whose name collides with an unrelated repo's
  // key (e.g. `git worktree add ../foo` next to a separate repo named `foo`).
  const ourSlug = canonical.repo || git.originSlug() || '';
  if (legacy.repo && ourSlug && legacy.repo !== ourSlug) return;
  if (!ourSlug && !canonicalExists) return; // can't confirm identity — stay safe

  const skipped: string[] = [];
  let changed = !canonicalExists;
  for (const [name, stack] of Object.entries(legacy.stacks ?? {})) {
    if (canonical.stacks[name]) {
      skipped.push(name); // canonical (main-checkout) copy wins
      continue;
    }
    canonical.stacks[name] = stack;
    changed = true;
  }
  if (!canonical.repo && (legacy.repo || ourSlug)) {
    canonical.repo = legacy.repo || ourSlug;
    changed = true;
  }
  if (
    canonical.currentStack == null &&
    legacy.currentStack &&
    canonical.stacks[legacy.currentStack]
  ) {
    canonical.currentStack = legacy.currentStack;
    changed = true;
  }
  if (!canonical.config && legacy.config) {
    canonical.config = legacy.config;
    changed = true;
  }

  // We're in the worktree, so getStackFilePath() resolves to canonicalPath.
  if (changed) saveState(canonical);

  // Archive the orphan rather than delete it (non-`.json` suffix keeps the
  // daemon's findStateFile from picking it up). Same for its history log.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    renameSync(legacyPath, `${legacyPath}.migrated-${stamp}`);
  } catch {
    /* best effort */
  }
  const legacyHistory = join(dir, `${legacyKey}.history.jsonl`);
  if (existsSync(legacyHistory)) {
    try {
      renameSync(legacyHistory, `${legacyHistory}.migrated-${stamp}`);
    } catch {
      /* best effort */
    }
  }

  if (skipped.length > 0) {
    process.stderr.write(
      `\x1b[33m⚠\x1b[0m Merged worktree stack state into ${canonicalKey}.json; ` +
        `kept existing stacks over worktree copies: ${skipped.join(', ')}.\n`,
    );
  }
}

export function refreshTips(state: StackFile): boolean {
	let changed = false;
	for (const stack of Object.values(state.stacks)) {
		for (const branch of stack.branches) {
			const result = git.tryRun('rev-parse', branch.name);
			if (result.ok && result.stdout !== branch.tip) {
				branch.tip = result.stdout;
				changed = true;
			}
		}
	}
	if (changed) {
		saveState(state);
	}
	return changed;
}

function backfillParentTips(state: StackFile): boolean {
	let dirty = false;
	for (const stack of Object.values(state.stacks)) {
		for (let i = 0; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (branch && branch.parentTip == null) {
				const parentRef =
					i === 0 ? stack.trunk : stack.branches[i - 1]?.name;
				if (parentRef) {
					const result = git.tryRun('merge-base', parentRef, branch.name);
					if (result.ok) {
						branch.parentTip = result.stdout;
						dirty = true;
					}
				}
			}
		}
	}
	return dirty;
}

export function loadAndRefreshState(): StackFile {
	const state = loadState();
	refreshTips(state);
	if (backfillParentTips(state)) {
		saveState(state);
	}
	return state;
}

export function findDependentStacks(
  state: StackFile,
  stackName: string,
): Array<{ name: string; stack: Stack }> {
  const result: Array<{ name: string; stack: Stack }> = [];
  for (const [name, stack] of Object.entries(state.stacks)) {
    if (stack.dependsOn?.some((p) => p.stack === stackName)) {
      result.push({ name, stack });
    }
  }
  return result;
}

export function findActiveStack(state: StackFile): StackPosition | null {
  let branch: string;
  try {
    branch = git.currentBranch();
  } catch {
    return null;
  }

  for (const [stackName, stack] of Object.entries(state.stacks)) {
    for (let i = 0; i < stack.branches.length; i++) {
      const b = stack.branches[i];
      if (b?.name === branch) {
        return {
          stackName,
          index: i,
          total: stack.branches.length,
          branch: b,
          isTop: i === stack.branches.length - 1,
          isBottom: i === 0,
        };
      }
    }
  }

  return null;
}
