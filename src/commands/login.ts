import { Command } from "clipanion";
import { loadClaudeCodeToken, migrateLegacyToken, oauthLogin } from "../lib/ai/oauth.js";
import * as ui from "../lib/ui.js";

export class LoginCommand extends Command {
	static override paths = [["login"]];
	static override usage = Command.Usage({
		description: "Log in with your Claude account (OAuth)",
		examples: [["Log in for AI features", "st login"]],
	});

	async execute(): Promise<number> {
		// Already logged in?
		if (loadClaudeCodeToken()) {
			ui.success("Already logged in.");
			return 0;
		}

		// Try migrating a legacy token first
		if (await migrateLegacyToken()) {
			ui.success("Migrated existing credentials. You're logged in.");
			return 0;
		}

		// Full OAuth flow
		const token = await oauthLogin();
		if (!token) {
			ui.error("Login cancelled or failed.");
			return 1;
		}
		ui.success("Logged in. AI descriptions will use your Claude account.");
		return 0;
	}
}
