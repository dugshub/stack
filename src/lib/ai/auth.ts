import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { getStackDir } from "../state.js";

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

/** Resolve API key from env or stored credentials. Returns null if none found. */
export function resolveApiKey(): string | null {
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) return envKey;
	const creds = loadCredentials();
	if (creds?.apiKey) return creds.apiKey;
	return null;
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
	return resolveApiKey() !== null;
}
