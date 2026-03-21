import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import * as ui from "../ui.js";

// Anthropic OAuth endpoints (same as Claude Code uses)
const AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CREATE_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "user:inference user:profile org:create_api_key";
const KEYCHAIN_SERVICE = "st-cli-credentials";

interface OAuthToken {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: string | null;
	apiKey: string | null; // Temporary API key created from the OAuth token
	createdAt: string;
}

// ── Keychain storage (macOS) ──

function keychainAccount(): string {
	return Bun.env.USER ?? "default";
}

export function loadOAuthToken(): OAuthToken | null {
	try {
		const result = Bun.spawnSync({
			cmd: ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(), "-w"],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) return null;
		const raw = result.stdout.toString().trim();
		if (!raw) return null;
		return JSON.parse(raw) as OAuthToken;
	} catch {
		return null;
	}
}

function saveOAuthToken(token: OAuthToken): void {
	const json = JSON.stringify(token);
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
		// Fallback: warn but don't fail
		ui.warn("Could not store credentials in Keychain. Token will need to be re-entered next time.");
	}
}

export function clearOAuthToken(): void {
	Bun.spawnSync({
		cmd: ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount()],
		stdout: "pipe",
		stderr: "pipe",
	});
}

/** Try to read Claude Code's OAuth token from macOS Keychain */
export function loadClaudeCodeToken(): string | null {
	try {
		const result = Bun.spawnSync({
			cmd: ["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", keychainAccount(), "-w"],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) return null;
		const raw = result.stdout.toString().trim();
		if (!raw) return null;
		const data = JSON.parse(raw);
		if (data.accessToken) return data.accessToken;
		if (data.apiKey) return data.apiKey;
		return null;
	} catch {
		return null;
	}
}

function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

/** Exchange an OAuth access token for a temporary Anthropic API key */
async function exchangeForApiKey(accessToken: string): Promise<string | null> {
	try {
		const response = await fetch(CREATE_API_KEY_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "st-cli" }),
		});
		if (!response.ok) return null;
		const data = await response.json() as any;
		return data.raw_key ?? data.api_key ?? data.key ?? null;
	} catch {
		return null;
	}
}

/** Get a usable API key from a stored OAuth token, creating one if needed */
export async function getApiKeyFromToken(token: OAuthToken): Promise<string | null> {
	// If we already have an API key, use it
	if (token.apiKey) return token.apiKey;

	// Exchange OAuth token for an API key
	const apiKey = await exchangeForApiKey(token.accessToken);
	if (apiKey) {
		// Cache the API key in the token
		token.apiKey = apiKey;
		saveOAuthToken(token);
	}
	return apiKey;
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
	ui.info("Opening browser to log in with your Anthropic account...");
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

		// Exchange OAuth token for a real API key
		const apiKey = await exchangeForApiKey(data.access_token);
		if (!apiKey) {
			throw new Error("Got OAuth token but failed to create API key from it");
		}

		const token: OAuthToken = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? null,
			expiresAt: data.expires_in
				? new Date(Date.now() + data.expires_in * 1000).toISOString()
				: null,
			apiKey,
			createdAt: new Date().toISOString(),
		};

		saveOAuthToken(token);
		return apiKey;
	} catch (err: any) {
		ui.error(`OAuth login failed: ${err.message}`);
		return null;
	}
}

/** Refresh an expired OAuth token and get a new API key */
export async function refreshOAuthToken(token: OAuthToken): Promise<string | null> {
	if (!token.refreshToken) return null;
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: token.refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) return null;

		const data = await response.json() as any;

		// Get a new API key from the refreshed token
		const apiKey = await exchangeForApiKey(data.access_token);

		const newToken: OAuthToken = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? token.refreshToken,
			expiresAt: data.expires_in
				? new Date(Date.now() + data.expires_in * 1000).toISOString()
				: null,
			apiKey: apiKey ?? token.apiKey, // Fall back to old key if exchange fails
			createdAt: new Date().toISOString(),
		};
		saveOAuthToken(newToken);
		return apiKey;
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
