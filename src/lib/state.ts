import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as git from './git.js';
import type { StackFile, StackPosition } from './types.js';

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
    return JSON.parse(text) as StackFile;
  } catch {
    return {
      repo: '',
      stacks: {},
    };
  }
}

export function saveState(state: StackFile): void {
  const filePath = getStackFilePath();
  const dir = getStackDir();
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

export function getHistoryFilePath(): string {
  const repoName = git.repoBasename();
  return join(getStackDir(), `${repoName}.history.jsonl`);
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
