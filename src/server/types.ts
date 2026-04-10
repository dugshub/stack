import type { MergeStrategy } from '../lib/types.js';
export type { MergeStrategy };

/** Parsed webhook events from GitHub */
export type WebhookEvent =
	| { type: 'pr_merged'; prNumber: number; repo: string }
	| { type: 'pr_closed'; prNumber: number; repo: string }
	| {
			type: 'push';
			repo: string;
			ref: string;
			branch: string;
			headSha: string;
	  };

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

export interface StackLock {
	stackName: string;
	acquiredAt: string;
	expiresAt: string; // TTL-based expiry (5 min default)
}

export interface LogEntry {
	timestamp: string;
	level: 'info' | 'success' | 'error' | 'warn';
	message: string;
	stack?: string; // optional: for filtering
	category?: 'webhook' | 'git' | 'api'; // direction indicator
	indent?: boolean; // visual grouping (cascade operations)
}
