import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as git from './git.js';
import { getHistoryFilePath, getStackDir, loadState, saveState } from './state.js';
import type { Stack } from './types.js';

const MAX_ENTRIES = 20;

interface UndoEntry {
	timestamp: string;
	command: string;
	stacks: Record<string, Stack>;
}

export interface SnapshotSummary {
	index: number;
	timestamp: string;
	command: string;
	stackCount: number;
	branchCount: number;
}

export interface RestoreResult {
	branchesReset: string[];
	branchesCreated: string[];
	branchesOrphaned: string[];
	stacksRestored: number;
}

function parseHistoryFile(filePath: string): UndoEntry[] {
	try {
		const text = readFileSync(filePath, 'utf-8');
		if (text.trim().length === 0) return [];
		return text
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as UndoEntry);
	} catch {
		return [];
	}
}

function writeHistoryFile(filePath: string, entries: UndoEntry[]): void {
	const dir = getStackDir();
	mkdirSync(dir, { recursive: true });
	const content = entries.map((e) => JSON.stringify(e)).join('\n');
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, content, 'utf-8');
	renameSync(tmpPath, filePath);
}

export function saveSnapshot(command: string): void {
	try {
		const state = loadState();
		if (Object.keys(state.stacks).length === 0) return;

		const entry: UndoEntry = {
			timestamp: new Date().toISOString(),
			command,
			stacks: JSON.parse(JSON.stringify(state.stacks)),
		};

		const filePath = getHistoryFilePath();
		const entries = parseHistoryFile(filePath);
		entries.push(entry);

		// Cap at MAX_ENTRIES — drop oldest
		while (entries.length > MAX_ENTRIES) {
			entries.shift();
		}

		writeHistoryFile(filePath, entries);
	} catch {
		// saveSnapshot is best-effort — swallow all errors
	}
}

export function listSnapshots(): SnapshotSummary[] {
	try {
		const filePath = getHistoryFilePath();
		const entries = parseHistoryFile(filePath);

		// Reverse so index 1 = most recent
		const reversed = [...entries].reverse();
		return reversed.map((entry, i) => {
			let branchCount = 0;
			for (const stack of Object.values(entry.stacks)) {
				branchCount += stack.branches.length;
			}
			return {
				index: i + 1,
				timestamp: entry.timestamp,
				command: entry.command,
				stackCount: Object.keys(entry.stacks).length,
				branchCount,
			};
		});
	} catch {
		return [];
	}
}

export function restoreSnapshot(steps: number): RestoreResult {
	const filePath = getHistoryFilePath();
	const entries = parseHistoryFile(filePath);

	if (entries.length < steps) {
		throw new Error(
			`Not enough history: only ${entries.length} snapshot(s) available, but ${steps} requested.`,
		);
	}

	const target = entries[entries.length - steps];
	if (!target) {
		throw new Error('Could not resolve target snapshot.');
	}

	// Abort any in-progress rebase
	if (git.isRebaseInProgress()) {
		git.tryRun('rebase', '--abort');
	}

	// Record current branch for later
	const originalBranch = git.tryRun('branch', '--show-current').stdout;

	const result: RestoreResult = {
		branchesReset: [],
		branchesCreated: [],
		branchesOrphaned: [],
		stacksRestored: 0,
	};

	// Collect all branch names in the target snapshot
	const snapshotBranches = new Set<string>();

	for (const stack of Object.values(target.stacks)) {
		for (const branch of stack.branches) {
			snapshotBranches.add(branch.name);
			if (branch.tip === null) continue;

			// Check if branch exists in git
			const exists = git.tryRun('rev-parse', '--verify', `refs/heads/${branch.name}`);
			if (exists.ok) {
				git.resetHard(branch.name, branch.tip);
				result.branchesReset.push(branch.name);
			} else {
				const created = git.branchCreate(branch.name, branch.tip);
				if (created) {
					result.branchesCreated.push(branch.name);
				}
			}
		}
		result.stacksRestored++;
	}

	// Find orphaned branches (in current state but not in snapshot)
	const currentState = loadState();
	for (const stack of Object.values(currentState.stacks)) {
		for (const branch of stack.branches) {
			if (!snapshotBranches.has(branch.name)) {
				result.branchesOrphaned.push(branch.name);
			}
		}
	}

	// Build new state with cleared restackState
	const newStacks: Record<string, Stack> = JSON.parse(JSON.stringify(target.stacks));
	for (const stack of Object.values(newStacks)) {
		stack.restackState = null;
	}
	const newState = {
		repo: currentState.repo,
		stacks: newStacks,
		currentStack: currentState.currentStack,
	};
	saveState(newState);

	// Truncate history: keep entries[0..length-steps)
	const truncated = entries.slice(0, entries.length - steps);
	writeHistoryFile(filePath, truncated);

	// Try to checkout original branch (best-effort)
	if (originalBranch) {
		git.tryRun('checkout', originalBranch);
	}

	return result;
}
