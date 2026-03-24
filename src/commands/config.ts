import { Command, Option } from "clipanion";
import { loadState, saveState } from "../lib/state.js";
import { theme } from "../lib/theme.js";
import * as ui from "../lib/ui.js";

export class ConfigCommand extends Command {
	static override paths = [["config"]];

	static override usage = Command.Usage({
		description: "View or update stack configuration",
		examples: [
			["Enable AI PR descriptions", "st config --describe"],
			["Disable AI PR descriptions", "st config --no-describe"],
			["View current config", "st config"],
		],
	});

	describe = Option.Boolean("--describe", {
		description: "Enable AI-generated PR descriptions (uses Claude Code OAuth)",
	});

	async execute(): Promise<number> {
		const state = loadState();

		if (this.describe === true) {
			const { ensureAuth } = await import("../lib/ai/pr-description.js");
			const hasAuth = await ensureAuth();
			if (!hasAuth) {
				ui.warn("Auth not configured. AI descriptions not enabled.");
				return 1;
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
			? theme.accent("Claude Code OAuth")
			: theme.muted("not configured — run `st login`");
		ui.heading("Configuration");
		ui.info(`  AI PR descriptions: ${descStatus}`);
		ui.info(`  Auth: ${authStatus}`);
		return 0;
	}
}
