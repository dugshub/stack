export interface Background {
	[section: string]: string | string[] | Record<string, string>;
}

export interface Judgment {
	heuristics: string[];
	constraints?: string[];
}

export interface Mission {
	objective: string;
	outputShape?: string;
}

export interface AgentDef {
	model: string;
	background: Background;
	judgment: Judgment;
	mission: Mission;
}

export function buildPrompt(def: AgentDef): string {
	const sections: string[] = [];

	sections.push("## Context");
	for (const [key, value] of Object.entries(def.background)) {
		if (typeof value === "string") {
			sections.push(`### ${key}\n${value}`);
		} else if (Array.isArray(value)) {
			sections.push(`### ${key}\n${value.map((v) => `- ${v}`).join("\n")}`);
		} else {
			const entries = Object.entries(value)
				.map(([k, v]) => `- **${k}**: ${v}`)
				.join("\n");
			sections.push(`### ${key}\n${entries}`);
		}
	}

	sections.push("## How to approach this");
	sections.push(def.judgment.heuristics.map((h) => `- ${h}`).join("\n"));
	if (def.judgment.constraints?.length) {
		sections.push(
			`### Constraints\n${def.judgment.constraints.map((c) => `- ${c}`).join("\n")}`,
		);
	}

	sections.push(`## Objective\n${def.mission.objective}`);
	if (def.mission.outputShape) {
		sections.push(
			`## Output format\nRespond with ONLY the following structure, no preamble:\n\n${def.mission.outputShape}`,
		);
	}

	return sections.join("\n\n");
}

export async function invoke(
	def: AgentDef,
	userMessage: string,
): Promise<string> {
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	const systemPrompt = buildPrompt(def);

	for await (const message of sdk.query({
		prompt: userMessage,
		options: {
			model: def.model,
			maxTurns: 1,
			systemPrompt,
			tools: [],
			persistSession: false,
		},
	})) {
		if (message.type === "result") {
			if (message.is_error) {
				const text =
					(message as any).result ||
					(message as any).errors?.join(", ") ||
					"AI invocation failed";
				throw new Error(text);
			}
			if (message.subtype === "success") {
				return (message as any).result as string;
			}
			if (
				typeof message.subtype === "string" &&
				message.subtype.startsWith("error")
			) {
				const errors = (message as any).errors as string[] | undefined;
				throw new Error(errors?.join(", ") || "AI invocation failed");
			}
		}
	}

	return "";
}
