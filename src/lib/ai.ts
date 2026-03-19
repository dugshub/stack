/**
 * AI primitives and agent definitions.
 *
 * Three primitives (borrowed from agentic-patterns):
 *   Background — what the agent knows (injected runtime context)
 *   Judgment   — how the agent thinks (heuristics, constraints, examples)
 *   Mission    — what the agent does (objective, output shape)
 *
 * An "agent" is just these three assembled into a prompt + a model choice.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface Background {
	[section: string]: string | string[] | Record<string, string>;
}

export interface Judgment {
	heuristics: string[];
	constraints?: string[];
	examples?: Array<{ input: string; output: string }>;
}

export interface Mission {
	objective: string;
	outputShape?: string;
	constraints?: string[];
}

export interface AgentDef {
	model: string;
	background: Background;
	judgment: Judgment;
	mission: Mission;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildPrompt(def: AgentDef): string {
	const sections: string[] = [];

	// Background
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

	// Judgment
	sections.push("## How to approach this");
	sections.push(def.judgment.heuristics.map((h) => `- ${h}`).join("\n"));
	if (def.judgment.constraints?.length) {
		sections.push(
			"### Constraints\n" +
				def.judgment.constraints.map((c) => `- ${c}`).join("\n"),
		);
	}
	if (def.judgment.examples?.length) {
		sections.push("### Examples");
		for (const ex of def.judgment.examples) {
			sections.push(`**Input:**\n${ex.input}\n\n**Output:**\n${ex.output}`);
		}
	}

	// Mission
	sections.push(`## Objective\n${def.mission.objective}`);
	if (def.mission.constraints?.length) {
		sections.push(def.mission.constraints.map((c) => `- ${c}`).join("\n"));
	}
	if (def.mission.outputShape) {
		sections.push(
			`## Output format\nRespond with ONLY the following structure, no preamble:\n\n${def.mission.outputShape}`,
		);
	}

	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

export async function invoke(def: AgentDef, userMessage: string): Promise<string> {
	const systemPrompt = buildPrompt(def);

	for await (const message of query({
		prompt: userMessage,
		options: {
			model: def.model,
			maxTurns: 1,
			systemPrompt,
		},
	})) {
		if ("result" in message) {
			return message.result;
		}
	}

	return "";
}
