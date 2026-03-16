import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MergeJob } from './types.js';

const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getJobsFilePath(): string {
	return join(homedir(), '.claude', 'stacks', 'merge-jobs.json');
}

function atomicWriteJson(filePath: string, data: unknown): void {
	const dir = join(filePath, '..');
	mkdirSync(dir, { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
	renameSync(tmpPath, filePath);
}

function pruneOldJobs(
	jobs: Record<string, MergeJob>,
): Record<string, MergeJob> {
	const now = Date.now();
	const pruned: Record<string, MergeJob> = {};
	for (const [id, job] of Object.entries(jobs)) {
		if (
			(job.status === 'completed' || job.status === 'failed') &&
			now - new Date(job.updated).getTime() > PRUNE_AGE_MS
		) {
			continue;
		}
		pruned[id] = job;
	}
	return pruned;
}

export function loadAllJobs(): Record<string, MergeJob> {
	const filePath = getJobsFilePath();
	try {
		const text = readFileSync(filePath, 'utf-8');
		const jobs = JSON.parse(text) as Record<string, MergeJob>;
		return pruneOldJobs(jobs);
	} catch {
		return {};
	}
}

export function loadJob(id: string): MergeJob | null {
	const jobs = loadAllJobs();
	return jobs[id] ?? null;
}

export function saveJob(job: MergeJob): void {
	const jobs = loadAllJobs();
	job.updated = new Date().toISOString();
	jobs[job.id] = job;
	atomicWriteJson(getJobsFilePath(), jobs);
}

export function findJobForPR(
	repo: string,
	prNumber: number,
): MergeJob | null {
	const jobs = loadAllJobs();
	for (const job of Object.values(jobs)) {
		if (job.repo !== repo || job.status !== 'running') continue;
		for (const step of job.steps) {
			if (step.prNumber === prNumber) {
				return job;
			}
		}
	}
	return null;
}

export function findActiveJobForStack(stackName: string): MergeJob | null {
	const jobs = loadAllJobs();
	for (const job of Object.values(jobs)) {
		if (job.stackName === stackName && job.status === 'running') {
			return job;
		}
	}
	return null;
}
