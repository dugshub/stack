import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as git from './git.js';
import type { Stack, StackFile, StackParent, StackPosition } from './types.js';

export function getStackDir(): string {
  return join(homedir(), '.claude', 'stacks');
}

export function getStackFilePath(): string {
  const repoName = git.repoBasename();
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
  // Collapse single-element dependsOn arrays to the legacy object shape on
  // disk so older builds keep reading state files we write (phase 1 of the
  // multi-parent migration). Arrays with 2+ parents are written as-is.
  const serializable: StackFile = {
    ...state,
    stacks: Object.fromEntries(
      Object.entries(state.stacks).map(([name, stack]) => {
        if (stack.dependsOn && stack.dependsOn.length === 1) {
          const { dependsOn, ...rest } = stack;
          return [
            name,
            {
              ...rest,
              dependsOn: dependsOn[0] as unknown as StackParent[],
            },
          ];
        }
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
  const repoName = git.repoBasename();
  return join(getStackDir(), `${repoName}.history.jsonl`);
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
