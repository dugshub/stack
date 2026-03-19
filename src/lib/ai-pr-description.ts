/**
 * PR description agent — generates PR bodies from diffs + commits.
 */

import { type AgentDef, invoke } from "./ai.js";
import * as git from "./git.js";

function buildAgent(context: {
	stackName: string;
	position: string;
	baseBranch: string;
	headBranch: string;
}): AgentDef {
	return {
		model: "claude-haiku-4-5",
		background: {
			"Stack info": {
				stack: context.stackName,
				position: context.position,
				base: context.baseBranch,
				head: context.headBranch,
			},
		},
		judgment: {
			heuristics: [
				"Derive the WHY from commit messages — the diff shows the what",
				"If it's a single-file change, keep the summary to 1-2 sentences",
				"Group related changes together rather than listing every file",
				"Use imperative mood: 'Add feature' not 'Added feature'",
				"PR descriptions are for reviewers — highlight what they should pay attention to",
			],
			constraints: [
				"Never mention line numbers or specific diff hunks",
				"Don't explain obvious things like 'updated imports'",
				"Keep it concise — max 3-5 bullet points in changes",
			],
		},
		mission: {
			objective:
				"Write a PR description based on the diff and commit messages provided.",
			outputShape: `## Summary
<1-2 sentence high-level description of what this PR does and why>

## Changes
<bulleted list of meaningful changes>

---
**Stack:** \`${context.stackName}\` (${context.position})
*🤖 Generated with [Claude Code](https://claude.com/claude-code)*`,
		},
	};
}

export async function generatePrDescription(opts: {
	baseBranch: string;
	headBranch: string;
	stackName: string;
	branchIndex: number;
	totalBranches: number;
}): Promise<string> {
	const diff = git.run("diff", `${opts.baseBranch}...${opts.headBranch}`);
	const commits = git.log(
		`${opts.baseBranch}..${opts.headBranch}`,
		"%s%n%b%n---",
	);

	const position = `PR ${opts.branchIndex + 1} of ${opts.totalBranches}`;

	const agent = buildAgent({
		stackName: opts.stackName,
		position,
		baseBranch: opts.baseBranch,
		headBranch: opts.headBranch,
	});

	const userMessage = [
		"## Commits",
		commits.join("\n"),
		"",
		"## Diff",
		diff,
	].join("\n");

	return invoke(agent, userMessage);
}
