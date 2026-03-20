import { Command, Option } from "clipanion";
import { loadState, saveState } from "../lib/state.js";
import { theme } from "../lib/theme.js";
import * as ui from "../lib/ui.js";

export class ConfigCommand extends Command {
	static override paths = [["config"]];

	static override usage = Command.Usage({
		description: "View or update stack configuration",
		examples: [
			["Enable AI PR descriptions", "stack config --describe"],
			["Disable AI PR descriptions", "stack config --no-describe"],
			[
				"Set API key non-interactively",
				"stack config --describe --key sk-ant-...",
			],
			["View current config", "stack config"],
		],
	});

	describe = Option.Boolean("--describe", {
		description: "Enable AI-generated PR descriptions (uses Anthropic API)",
	});

	key = Option.String("--key", {
		description: "Anthropic API key (for non-interactive setup)",
	});

	async execute(): Promise<number> {
		const state = loadState();

		if (this.describe === true) {
			// Enable: ensure auth
			ui.info("AI descriptions use the Anthropic API (billed to your account).");
			if (this.key) {
				const { saveCredentials } = await import("../lib/ai/auth.js");
				saveCredentials({
					apiKey: this.key,
					createdAt: new Date().toISOString(),
				});
				ui.success("API key saved.");
			} else {
				const { ensureAuth } = await import("../lib/ai/pr-description.js");
				const apiKey = await ensureAuth();
				if (!apiKey) {
					ui.warn("No API key provided. AI descriptions not enabled.");
					return 1;
				}
			}
			if (!state.config) state.config = {};
			state.config.describe = true;
			saveState(state);
			ui.success(`AI PR descriptions: ${theme.accent("enabled")}`);
			return 0;
		}

		if (this.describe === false) {
			// --no-describe
			if (!state.config) state.config = {};
			state.config.describe = false;
			saveState(state);
			ui.success(`AI PR descriptions: ${theme.muted("disabled")}`);
			return 0;
		}

		// Show config
		const { hasCredentials } = await import("../lib/ai/auth.js");
		const descStatus = state.config?.describe
			? theme.accent("enabled")
			: theme.muted("disabled");
		const authStatus = hasCredentials()
			? theme.accent("configured")
			: theme.muted("not configured");
		ui.heading("Configuration");
		ui.info(`  AI PR descriptions: ${descStatus}`);
		ui.info(`  API key: ${authStatus}`);
		return 0;
	}
}
