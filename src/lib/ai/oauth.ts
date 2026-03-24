import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import * as ui from "../ui.js";

// Anthropic OAuth endpoints — claude.ai for subscription-based (Max) login
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload";

// Store in Claude Code's Keychain entry so the Agent SDK subprocess can find it
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const LEGACY_KEYCHAIN_SERVICE = "st-cli-credentials";

// ── Keychain storage (macOS) ──

function keychainAccount(): string {
	return Bun.env.USER ?? "default";
}

interface ClaudeCodeCredentials {
	claudeAiOauth?: {
		accessToken: string;
		refreshToken?: string;
		expiresAt?: number;
		scopes?: string[];
		subscriptionType?: string;
	};
	mcpOAuth?: Record<string, unknown>;
}

function loadKeychainEntry(): ClaudeCodeCredentials | null {
	try {
		const result = Bun.spawnSync({
			cmd: ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(), "-w"],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) return null;
		const raw = result.stdout.toString().trim();
		if (!raw) return null;
		return JSON.parse(raw) as ClaudeCodeCredentials;
	} catch {
		return null;
	}
}

function saveKeychainEntry(data: ClaudeCodeCredentials): void {
	const json = JSON.stringify(data);
	const account = keychainAccount();

	// Delete existing entry (ignore errors)
	Bun.spawnSync({
		cmd: ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
		stdout: "pipe",
		stderr: "pipe",
	});

	// Add new entry
	const result = Bun.spawnSync({
		cmd: ["security", "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", json],
		stdout: "pipe",
		stderr: "pipe",
	});

	if (result.exitCode !== 0) {
		ui.warn("Could not store credentials in Keychain.");
	}
}

/** Check if Claude Code has valid OAuth credentials */
export function loadClaudeCodeToken(): string | null {
	const data = loadKeychainEntry();
	const oauth = data?.claudeAiOauth;
	if (!oauth?.accessToken) return null;
	if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
	return oauth.accessToken;
}

export function clearOAuthToken(): void {
	const data = loadKeychainEntry();
	if (!data?.claudeAiOauth) return;
	delete data.claudeAiOauth;
	saveKeychainEntry(data);
}

/**
 * Migrate legacy st-cli-credentials to Claude Code's Keychain format.
 * Uses the refresh token to get a fresh access token, writes it to the
 * new location, then deletes the old entry. No-op if already migrated.
 */
export async function migrateLegacyToken(): Promise<boolean> {
	// Already have credentials — nothing to migrate
	if (loadClaudeCodeToken()) return true;

	// Check for legacy entry
	let legacy: { accessToken?: string; refreshToken?: string } | null = null;
	try {
		const result = Bun.spawnSync({
			cmd: ["security", "find-generic-password", "-s", LEGACY_KEYCHAIN_SERVICE, "-a", keychainAccount(), "-w"],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) return false;
		const raw = result.stdout.toString().trim();
		if (!raw) return false;
		legacy = JSON.parse(raw);
	} catch {
		return false;
	}

	if (!legacy?.refreshToken) {
		deleteLegacyEntry();
		return false;
	}

	// Refresh the old token to get a fresh access token
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: legacy.refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			deleteLegacyEntry();
			return false;
		}

		const data = await response.json() as any;

		// Write to Claude Code's Keychain format
		const existing = loadKeychainEntry() ?? {};
		existing.claudeAiOauth = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? legacy.refreshToken,
			expiresAt: data.expires_in
				? Date.now() + data.expires_in * 1000
				: undefined,
			scopes: SCOPES.split(" "),
		};
		saveKeychainEntry(existing);
		deleteLegacyEntry();
		return true;
	} catch {
		deleteLegacyEntry();
		return false;
	}
}

function deleteLegacyEntry(): void {
	Bun.spawnSync({
		cmd: ["security", "delete-generic-password", "-s", LEGACY_KEYCHAIN_SERVICE, "-a", keychainAccount()],
		stdout: "pipe",
		stderr: "pipe",
	});
}

function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

/** Run the full OAuth PKCE login flow. Opens browser, waits for callback. */
export async function oauthLogin(): Promise<string | null> {
	const { verifier, challenge } = generatePKCE();
	const state = randomBytes(16).toString("hex");

	// Start local server to receive the callback
	const { port, codePromise, server } = await startCallbackServer(state);

	const redirectUri = `http://localhost:${port}/callback`;
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: redirectUri,
		scope: SCOPES,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});

	const authorizeUrl = `${AUTHORIZE_URL}?${params}`;

	// Open browser
	ui.info("Opening browser to log in with your Claude account...");
	const { spawn } = await import("node:child_process");
	spawn("open", [authorizeUrl], { stdio: "ignore", detached: true }).unref();
	ui.info("If the browser didn't open, visit:");
	ui.info(authorizeUrl);

	// Wait for callback (timeout after 5 minutes)
	let code: string;
	try {
		code = await Promise.race([
			codePromise,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Login timed out (5 minutes)")), 300_000)
			),
		]);
	} catch (err: any) {
		server.close();
		ui.error(err.message);
		return null;
	}

	server.close();

	// Exchange code for OAuth token
	try {
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: CLIENT_ID,
				code_verifier: verifier,
				state,
			}),
		});

		if (!tokenResponse.ok) {
			const text = await tokenResponse.text();
			throw new Error(`Token exchange failed (${tokenResponse.status}): ${text}`);
		}

		const data = await tokenResponse.json() as any;

		// Store in Claude Code's Keychain format (merge with existing data)
		const existing = loadKeychainEntry() ?? {};
		existing.claudeAiOauth = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? undefined,
			expiresAt: data.expires_in
				? Date.now() + data.expires_in * 1000
				: undefined,
			scopes: SCOPES.split(" "),
		};
		saveKeychainEntry(existing);

		return data.access_token;
	} catch (err: any) {
		ui.error(`OAuth login failed: ${err.message}`);
		return null;
	}
}

/** Refresh an expired OAuth token */
export async function refreshOAuthToken(): Promise<string | null> {
	const data = loadKeychainEntry();
	const oauth = data?.claudeAiOauth;
	if (!oauth?.refreshToken) return null;

	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: oauth.refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) return null;

		const result = await response.json() as any;

		// Update Keychain
		const existing = loadKeychainEntry() ?? {};
		existing.claudeAiOauth = {
			...oauth,
			accessToken: result.access_token,
			refreshToken: result.refresh_token ?? oauth.refreshToken,
			expiresAt: result.expires_in
				? Date.now() + result.expires_in * 1000
				: undefined,
		};
		saveKeychainEntry(existing);

		return result.access_token;
	} catch {
		return null;
	}
}

function startCallbackServer(
	expectedState: string,
): Promise<{ port: number; codePromise: Promise<string>; server: ReturnType<typeof createServer> }> {
	return new Promise((resolve) => {
		let resolveCode: (code: string) => void;
		let rejectCode: (err: Error) => void;
		const codePromise = new Promise<string>((res, rej) => {
			resolveCode = res;
			rejectCode = rej;
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost`);

			if (url.pathname === "/callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end("<html><body><h2>Login failed</h2><p>You can close this tab.</p></body></html>");
					rejectCode!(new Error(`OAuth error: ${error}`));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end("<html><body><h2>Invalid state</h2></body></html>");
					rejectCode!(new Error("OAuth state mismatch"));
					return;
				}

				if (!code) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end("<html><body><h2>No code received</h2></body></html>");
					rejectCode!(new Error("No authorization code received"));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					`<html><body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
					<div style="text-align: center;">
						<h2 style="color: #16a34a;">Logged in to st</h2>
						<p style="color: #666;">You can close this tab and return to your terminal.</p>
					</div>
				</body></html>`,
				);
				resolveCode!(code);
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as any;
			resolve({ port: addr.port, codePromise, server });
		});
	});
}
