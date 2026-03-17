import type { MergeStrategy } from '../lib/types.js';
export type { MergeStrategy };

/** Status of an individual merge step in the pipeline */
export type StepStatus =
	| 'pending'
	| 'auto-merge-enabled'
	| 'merged'
	| 'rebasing-next'
	| 'done'
	| 'failed';

/** Overall status of a merge job */
export type JobStatus = 'running' | 'completed' | 'failed';

/** A single PR merge step within a merge job */
export interface MergeStep {
	prNumber: number;
	branch: string;
	status: StepStatus;
	error?: string;
	mergedAt?: string;
	/** Stored before merge so we can use it as rebase exclusion point */
	branchTip?: string;
}

/** Represents a full stack merge operation with ordered steps */
export interface MergeJob {
	id: string;
	stackName: string;
	repo: string;
	trunk: string;
	status: JobStatus;
	strategy: MergeStrategy;
	steps: MergeStep[];
	currentStep: number;
	/** Set by engine when rebasing-next; cleared by server after actions succeed */
	pendingNextStep?: number;
	created: string;
	updated: string;
}

export type WebhookEvent =
	| { type: 'pr_merged'; prNumber: number; repo: string }
	| { type: 'pr_closed'; prNumber: number; repo: string }
	| {
			type: 'auto_merge_disabled';
			prNumber: number;
			repo: string;
			reason: string;
	  }
	| {
			type: 'push';
			repo: string;
			ref: string;
			branch: string;
			headSha: string;
	  };

export type EngineAction =
	| { type: 'enable-auto-merge'; prNumber: number; strategy: MergeStrategy }
	| { type: 'rebase-and-push'; branch: string; onto: string; oldBase: string }
	| { type: 'retarget-pr'; prNumber: number; newBase: string }
	| {
			type: 'delete-branches';
			branches: Array<{ name: string; remote: boolean }>;
	  }
	| { type: 'notify'; message: string; level: 'info' | 'success' | 'error' };

export interface TunnelConfig {
	configPath: string;
	hostname: string;
}

export interface DaemonConfig {
	port: number;
	webhookSecret: string;
	publicUrl?: string;
	tunnel?: TunnelConfig;
	webhooks: Record<string, number>;
	repos: string[];
}
