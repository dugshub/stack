import { Command } from "clipanion";
import { clearCredentials } from "../lib/ai/auth.js";
import { clearOAuthToken } from "../lib/ai/oauth.js";
import * as ui from "../lib/ui.js";

export class LogoutCommand extends Command {
	static override paths = [["logout"]];
	static override usage = Command.Usage({
		description: "Log out and clear stored credentials",
		examples: [["Clear all auth", "st logout"]],
	});

	async execute(): Promise<number> {
		clearOAuthToken();
		clearCredentials();
		ui.success("Logged out. Cleared all stored credentials.");
		return 0;
	}
}
