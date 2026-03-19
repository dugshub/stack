import { Command, Option } from "clipanion";
import { loadState, saveState } from "../lib/state.js";
import { theme } from "../lib/theme.js";
import * as ui from "../lib/ui.js";

export class ConfigCommand extends Command {
	static override paths = [["config"]];

	static override usage = Command.Usage({
		description: "View or update stack configuration",
		examples: [
			["Enable AI PR descriptions", "stack config --ai"],
			["Disable AI PR descriptions", "stack config --no-ai"],
			["View current config", "stack config"],
		],
	});

	ai = Option.Boolean("--ai", {
		description: "Enable AI-generated PR descriptions by default",
	});

	noAi = Option.Boolean("--no-ai", {
		description: "Disable AI-generated PR descriptions",
	});

	async execute(): Promise<number> {
		const state = loadState();

		// Set config
		if (this.ai || this.noAi) {
			if (!state.config) state.config = {};
			state.config.ai = this.noAi ? false : true;
			saveState(state);
			const status = state.config.ai ? theme.accent("enabled") : theme.muted("disabled");
			ui.success(`AI PR descriptions: ${status}`);
			return 0;
		}

		// Show config
		const aiStatus = state.config?.ai ? theme.accent("enabled") : theme.muted("disabled");
		ui.heading("Configuration");
		ui.info(`  AI PR descriptions: ${aiStatus}`);
		return 0;
	}
}
