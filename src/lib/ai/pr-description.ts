import { type AgentDef, invoke } from "./invoke.js";
import * as git from "../git.js";
import { loadClaudeCodeToken, migrateLegacyToken, oauthLogin } from "./oauth.js";
import * as ui from "../ui.js";

const MAX_DIFF_CHARS = 12_000;

function buildAgent(context: {
	stackName: string;
	position: string;
	baseBranch: string;
	headBranch: string;
}): AgentDef {
	return {
		model: "claude-sonnet-4-6",
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
				"Derive the WHY from commit messages -- the diff shows the what",
				"If it's a single-file change, keep the summary to 1-2 sentences",
				"Group related changes together rather than listing every file",
				"Use imperative mood: 'Add feature' not 'Added feature'",
				"PR descriptions are for reviewers -- highlight what they should pay attention to",
			],
			constraints: [
				"Never mention line numbers or specific diff hunks",
				"Don't explain obvious things like 'updated imports'",
				"Keep it concise -- max 3-5 bullet points in changes",
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
*Managed by [stack CLI](https://github.com/dugshub/stack)*`,
		},
	};
}

/**
 * Ensure Claude Code is authenticated (OAuth via Keychain).
 * If not, prompt the user to log in via `st login`.
 */
export async function ensureAuth(): Promise<boolean> {
	// Check if Claude Code has OAuth credentials in Keychain
	if (loadClaudeCodeToken()) return true;

	// Try migrating legacy st-cli-credentials → Claude Code format
	const migrated = await migrateLegacyToken();
	if (migrated) {
		ui.success("Migrated existing credentials.");
		return true;
	}

	// No credentials — prompt for OAuth login
	ui.info("Log in with your Claude account to enable AI descriptions.");
	const accessToken = await oauthLogin();
	if (!accessToken) return false;

	ui.success("Logged in successfully.");
	return true;
}

export async function generatePrDescription(opts: {
	baseBranch: string;
	headBranch: string;
	stackName: string;
	branchIndex: number;
	totalBranches: number;
}): Promise<string> {
	let diff = git.run("diff", `${opts.baseBranch}...${opts.headBranch}`);
	if (diff.length > MAX_DIFF_CHARS) {
		diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`;
	}
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
