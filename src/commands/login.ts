import { Command } from "clipanion";
import { oauthLogin } from "../lib/ai/oauth.js";
import * as ui from "../lib/ui.js";

export class LoginCommand extends Command {
	static override paths = [["login"]];
	static override usage = Command.Usage({
		description: "Log in with your Anthropic account (OAuth)",
		examples: [["Log in for AI features", "st login"]],
	});

	async execute(): Promise<number> {
		const token = await oauthLogin();
		if (!token) {
			ui.error("Login cancelled or failed.");
			return 1;
		}
		ui.success("Logged in. AI descriptions will use your Anthropic account.");
		return 0;
	}
}
