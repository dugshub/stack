import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { getStackDir } from "../state.js";
import * as ui from "../ui.js";
import { theme } from "../theme.js";
import {
	loadOAuthToken,
	loadClaudeCodeToken,
	refreshOAuthToken,
	oauthLogin,
} from "./oauth.js";

interface AICredentials {
	apiKey: string;
	createdAt: string;
}

function credentialsPath(): string {
	return join(getStackDir(), "ai-credentials.json");
}

export function loadCredentials(): AICredentials | null {
	const path = credentialsPath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

export function saveCredentials(creds: AICredentials): void {
	const path = credentialsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`);
}

export function clearCredentials(): void {
	const path = credentialsPath();
	if (existsSync(path)) unlinkSync(path);
}

export type AuthSource = "oauth" | "claude-code" | "env-api-key" | "stored-api-key";

export interface ResolvedAuth {
	apiKey: string;
	source: AuthSource;
}

/**
 * Resolve auth in priority order:
 * 1. Stored OAuth token (from `st login`)
 * 2. Claude Code's OAuth token (macOS Keychain)
 * 3. ANTHROPIC_API_KEY env var (with loud warning)
 * 4. Stored API key (from `st config --key`)
 */
export function resolveAuth(): ResolvedAuth | null {
	// 1. Our own OAuth token — use access token directly
	const oauthToken = loadOAuthToken();
	if (oauthToken?.accessToken) {
		return { apiKey: oauthToken.accessToken, source: "oauth" };
	}

	// 2. Claude Code's token from Keychain
	const ccToken = loadClaudeCodeToken();
	if (ccToken) {
		return { apiKey: ccToken, source: "claude-code" };
	}

	// 3. Env var (with warning)
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) {
		return { apiKey: envKey, source: "env-api-key" };
	}

	// 4. Stored API key
	const creds = loadCredentials();
	if (creds?.apiKey) {
		return { apiKey: creds.apiKey, source: "stored-api-key" };
	}

	return null;
}

/** Async version that can refresh expired OAuth tokens */
export async function resolveAuthAsync(): Promise<ResolvedAuth | null> {
	// 1. Our own OAuth token — use access token directly
	const oauthToken = loadOAuthToken();
	if (oauthToken) {
		if (oauthToken.accessToken) {
			return { apiKey: oauthToken.accessToken, source: "oauth" };
		}
		// Token might be expired — try refresh
		if (oauthToken.refreshToken) {
			const refreshed = await refreshOAuthToken(oauthToken);
			if (refreshed) {
				return { apiKey: refreshed, source: "oauth" };
			}
		}
	}

	// Fall through to sync resolution for the rest
	return resolveAuth();
}

/** Show appropriate warning based on auth source */
export function showAuthSourceWarning(auth: ResolvedAuth): void {
	switch (auth.source) {
		case "oauth":
			// Clean — no warning needed
			break;
		case "claude-code":
			ui.info(`Using Claude Code OAuth credentials`);
			break;
		case "env-api-key":
			ui.warn(
				theme.warning("╔══════════════════════════════════════════════════════════╗"),
			);
			ui.warn(
				theme.warning("║  Using ANTHROPIC_API_KEY from your environment.          ║"),
			);
			ui.warn(
				theme.warning("║  API calls will be billed to this key's account.         ║"),
			);
			ui.warn(
				theme.warning("║  Run `st login` to use OAuth instead (no API key needed) ║"),
			);
			ui.warn(
				theme.warning("╚══════════════════════════════════════════════════════════╝"),
			);
			break;
		case "stored-api-key":
			ui.warn(
				theme.warning("╔══════════════════════════════════════════════════════════╗"),
			);
			ui.warn(
				theme.warning("║  Using stored API key — billed to your Anthropic account ║"),
			);
			ui.warn(
				theme.warning("║  Run `st login` to use OAuth instead (no API key needed) ║"),
			);
			ui.warn(
				theme.warning("╚══════════════════════════════════════════════════════════╝"),
			);
			break;
	}
}

// Legacy compat — resolveApiKey returns just the key string
export function resolveApiKey(): string | null {
	return resolveAuth()?.apiKey ?? null;
}

/** Interactive prompt for API key. Returns the key or null if cancelled. */
export async function promptForApiKey(): Promise<string | null> {
	const { text } = await import("@clack/prompts");
	const result = await text({
		message:
			"Enter your Anthropic API key (from console.anthropic.com/settings/keys):",
		placeholder: "sk-ant-...",
		validate: (v) => {
			if (!v?.startsWith("sk-ant-")) return "API key should start with sk-ant-";
		},
	});
	if (typeof result !== "string") return null;
	return result;
}

/** Check if credentials are available (without prompting). */
export function hasCredentials(): boolean {
	return resolveAuth() !== null;
}
