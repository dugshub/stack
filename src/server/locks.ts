import type { StackLock } from './types.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const locks = new Map<string, StackLock>();

export function acquireLock(stackName: string, ttlMs = DEFAULT_TTL_MS): boolean {
	// Check for expired locks
	const existing = locks.get(stackName);
	if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
		return false; // Already locked
	}

	locks.set(stackName, {
		stackName,
		acquiredAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + ttlMs).toISOString(),
	});
	return true;
}

export function releaseLock(stackName: string): void {
	locks.delete(stackName);
}

export function isStackLocked(stackName: string): boolean {
	const lock = locks.get(stackName);
	if (!lock) return false;
	if (new Date(lock.expiresAt).getTime() <= Date.now()) {
		locks.delete(stackName);
		return false;
	}
	return true;
}

export function activeLockCount(): number {
	// Prune expired
	for (const [name, lock] of locks) {
		if (new Date(lock.expiresAt).getTime() <= Date.now()) {
			locks.delete(name);
		}
	}
	return locks.size;
}

export function listActiveLocks(): StackLock[] {
	// Prune expired first
	for (const [name, lock] of locks) {
		if (new Date(lock.expiresAt).getTime() <= Date.now()) {
			locks.delete(name);
		}
	}
	return Array.from(locks.values());
}
