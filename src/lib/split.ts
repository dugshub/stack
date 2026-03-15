import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBranchName } from './branch.js';
import * as git from './git.js';

export interface SplitPattern {
	glob: string;
	negated: boolean;
}

export interface SplitEntry {
	branchDescription: string;
	patterns: SplitPattern[];
}

export interface FileStats {
	path: string;
	added: number;
	removed: number;
	isNew: boolean;
}

export interface SplitPlanEntry {
	branchDescription: string;
	branchName: string;
	files: FileStats[];
	totalAdded: number;
	totalRemoved: number;
}

export interface SplitPlan {
	stackName: string;
	trunk: string;
	entries: SplitPlanEntry[];
	unassigned: FileStats[];
	totalAdded: number;
	totalRemoved: number;
	totalFiles: number;
	newFiles: number;
}

/** Parse `branch-name:pattern[:pattern...]` arguments into SplitEntry objects. */
export function parseSplitArgs(args: string[]): SplitEntry[] {
	const entries: SplitEntry[] = [];
	for (const arg of args) {
		const parts = arg.split(':');
		const description = parts[0];
		if (!description || parts.length < 2) {
			throw new Error(
				`Invalid split spec "${arg}": expected "branch-name:pattern[:pattern...]"`,
			);
		}
		const patterns: SplitPattern[] = [];
		for (let i = 1; i < parts.length; i++) {
			const raw = parts[i];
			if (!raw || raw.length === 0) continue;
			if (raw.startsWith('!')) {
				patterns.push({ glob: raw.slice(1), negated: true });
			} else {
				patterns.push({ glob: raw, negated: false });
			}
		}
		const hasPositive = patterns.some((p) => !p.negated);
		if (!hasPositive) {
			throw new Error(
				`Split spec "${arg}" must have at least one non-negated pattern`,
			);
		}
		entries.push({ branchDescription: description, patterns });
	}
	return entries;
}

/** Match files for a split entry, respecting first-match-wins via the claimed set. */
export function matchFiles(
	entry: SplitEntry,
	allFiles: string[],
	claimed: Set<string>,
): string[] {
	const included = new Set<string>();

	// Apply positive patterns first
	for (const pattern of entry.patterns) {
		if (pattern.negated) continue;
		const glob = new Bun.Glob(pattern.glob);
		for (const file of allFiles) {
			if (claimed.has(file)) continue;
			if (glob.match(file)) {
				included.add(file);
			}
		}
	}

	// Then subtract negated patterns
	for (const pattern of entry.patterns) {
		if (!pattern.negated) continue;
		const glob = new Bun.Glob(pattern.glob);
		for (const file of included) {
			if (glob.match(file)) {
				included.delete(file);
			}
		}
	}

	return [...included];
}

/** Get diff stats for a list of files. New files use line count; modified files use git diff --numstat. */
export function getFileStats(files: string[]): FileStats[] {
	const repoRoot = git.repoRoot();
	const numstat = git.diffNumstat();
	const numstatMap = new Map<string, { added: number; removed: number }>();
	for (const entry of numstat) {
		numstatMap.set(entry.path, { added: entry.added, removed: entry.removed });
	}

	// Determine which files are untracked (new)
	// Use raw Bun.spawnSync to avoid tryRun's .trim() corrupting leading spaces
	const untrackedSet = new Set<string>();
	const statusProc = Bun.spawnSync(['git', 'status', '--porcelain', '-u'], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (statusProc.exitCode === 0) {
		for (const line of statusProc.stdout.toString().split('\n')) {
			if (line.startsWith('??') || line.startsWith('A ')) {
				const path = line.slice(3);
				if (path.length > 0) {
					untrackedSet.add(path);
				}
			}
		}
	}

	const stats: FileStats[] = [];
	for (const file of files) {
		const isNew = untrackedSet.has(file);
		const ns = numstatMap.get(file);
		if (ns && !isNew) {
			stats.push({ path: file, added: ns.added, removed: ns.removed, isNew });
		} else {
			// New or untracked file: count lines
			try {
				const content = readFileSync(join(repoRoot, file), 'utf-8');
				const lines = content.split('\n').length;
				// If file ends with newline, last element is empty
				const lineCount =
					content.endsWith('\n') ? lines - 1 : lines;
				stats.push({ path: file, added: lineCount, removed: 0, isNew: true });
			} catch {
				stats.push({ path: file, added: 0, removed: 0, isNew: true });
			}
		}
	}
	return stats;
}

/** Build a complete split plan from parsed entries. */
export function buildSplitPlan(opts: {
	stackName: string;
	trunk: string;
	user: string;
	entries: SplitEntry[];
}): SplitPlan {
	const allFiles = git.allDirtyFiles();
	const claimed = new Set<string>();

	const planEntries: SplitPlanEntry[] = [];
	let entryIndex = 1;

	for (const entry of opts.entries) {
		const matched = matchFiles(entry, allFiles, claimed);
		if (matched.length === 0) continue;

		for (const file of matched) {
			claimed.add(file);
		}

		const stats = getFileStats(matched);
		const totalAdded = stats.reduce((sum, s) => sum + s.added, 0);
		const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0);

		const branchName = buildBranchName(
			opts.user,
			opts.stackName,
			entryIndex,
			entry.branchDescription,
		);

		planEntries.push({
			branchDescription: entry.branchDescription,
			branchName,
			files: stats,
			totalAdded,
			totalRemoved,
		});

		entryIndex++;
	}

	// Unassigned files
	const unassignedFiles = allFiles.filter((f) => !claimed.has(f));
	const unassigned = getFileStats(unassignedFiles);

	const totalAdded =
		planEntries.reduce((sum, e) => sum + e.totalAdded, 0);
	const totalRemoved =
		planEntries.reduce((sum, e) => sum + e.totalRemoved, 0);
	const allStats = planEntries.flatMap((e) => e.files);
	const totalFiles = allStats.length;
	const newFiles = allStats.filter((s) => s.isNew).length;

	return {
		stackName: opts.stackName,
		trunk: opts.trunk,
		entries: planEntries,
		unassigned,
		totalAdded,
		totalRemoved,
		totalFiles,
		newFiles,
	};
}
