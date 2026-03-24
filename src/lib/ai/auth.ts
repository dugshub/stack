import { loadClaudeCodeToken } from "./oauth.js";

/** Check if Claude Code OAuth credentials are available. */
export function hasCredentials(): boolean {
	return loadClaudeCodeToken() !== null;
}
