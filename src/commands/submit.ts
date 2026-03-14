import { Command, Option } from "clipanion";
import { descriptionToTitle, parseBranchName } from "../lib/branch.js";
import { generateComment } from "../lib/comment.js";
import * as git from "../lib/git.js";
import {
	type BatchReadResult,
	fetchPRDetails,
	MutationBatch,
} from "../lib/graphql.js";
import { findActiveStack, loadState, saveState } from "../lib/state.js";
import { theme } from "../lib/theme.js";
import type { PrStatus } from "../lib/types.js";
import * as ui from "../lib/ui.js";

export class SubmitCommand extends Command {
	static override paths = [["submit"]];

	static override usage = Command.Usage({
		description: "Push branches and create/update PRs for the stack",
		examples: [
			["Show what would happen", "stack submit --dry-run"],
			["Push and create/update PRs", "stack submit"],
		],
	});

	dryRun = Option.Boolean("--dry-run", false, {
		description: "Show what would happen without making changes",
	});

	async execute(): Promise<number> {
		const state = loadState();
		const position = findActiveStack(state);

		if (!position) {
			ui.error(
				`Not on a stack branch. Use ${theme.command("stack status")} to see tracked stacks.`,
			);
			return 2;
		}

		const stack = state.stacks[position.stackName];
		if (!stack) {
			ui.error(`Stack "${position.stackName}" not found`);
			return 2;
		}

		if (this.dryRun) {
			return this.showDryRun(stack, position.stackName);
		}

		return this.fullSubmit(state, stack, position.stackName);
	}

	private showDryRun(
		stack: ReturnType<typeof loadState>["stacks"][string] & object,
		_stackName: string,
	): number {
		const createCount = stack.branches.filter((b) => b.pr == null).length;
		const updateCount = stack.branches.filter((b) => b.pr != null).length;

		ui.heading(
			`\nWould push ${stack.branches.length} branches and create ${createCount}/update ${updateCount} PRs:\n`,
		);

		process.stderr.write(
			`  ${theme.muted("Branch".padEnd(50))} ${theme.muted("Base".padEnd(20))} ${theme.muted("Action")}\n`,
		);
		process.stderr.write(
			`  ${"".padEnd(50, "\u2500")} ${"".padEnd(20, "\u2500")} ${"".padEnd(20, "\u2500")}\n`,
		);

		for (let i = 0; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch) continue;
			const base =
				i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);
			const action =
				branch.pr != null
					? theme.accent(`update PR #${branch.pr}`)
					: theme.accent("create PR (draft)");
			const shortBase = base.length > 18 ? `${base.slice(0, 15)}...` : base;
			process.stderr.write(
				`  ${theme.branch(branch.name.padEnd(50))} ${shortBase.padEnd(20)} ${action}\n`,
			);
		}

		process.stderr.write(
			`\nRun ${theme.command("stack submit")} to proceed.\n`,
		);
		return 0;
	}

	private fullSubmit(
		state: ReturnType<typeof loadState>,
		stack: ReturnType<typeof loadState>["stacks"][string] & object,
		stackName: string,
	): number {
		const originalBranch = git.currentBranch();
		const repoUrl = `https://github.com/${state.repo}`;

		// Phase 1: Push (only changed branches)
		ui.heading("\nPushing branches...");
		for (const branch of stack.branches) {
			if (!git.needsPush(branch.name)) {
				ui.info(`  \u2191 ${theme.branch(branch.name)} (up to date)`);
				continue;
			}
			if (git.hasRemoteRef(branch.name)) {
				const pushResult = git.pushForceWithLease("origin", branch.name);
				if (pushResult.ok) {
					ui.success(`Pushed ${theme.branch(branch.name)}`);
				} else {
					ui.error(
						`Push rejected for ${theme.branch(branch.name)}. Someone else may have pushed. Run ${theme.command("git fetch")} and check.`,
					);
					return 2;
				}
			} else {
				try {
					git.pushNew("origin", branch.name);
					ui.success(`Pushed ${theme.branch(branch.name)} (new)`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ui.error(`Failed to push ${theme.branch(branch.name)}: ${msg}`);
					return 2;
				}
			}
			branch.tip = git.revParse(branch.name);
		}

		// Phase 2: Batch Read (one GraphQL call)
		const [owner, repo] = state.repo.split("/");
		if (!owner || !repo) {
			ui.error(`Invalid repo format: ${state.repo}`);
			return 2;
		}

		const existingPrNumbers = stack.branches
			.filter((b) => b.pr != null)
			.map((b) => b.pr as number);

		let batchRead: BatchReadResult;
		try {
			batchRead = fetchPRDetails(owner, repo, existingPrNumbers);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ui.error(`Failed to fetch PR details: ${msg}`);
			return 2;
		}

		const { repoNodeId, prs: prDetailsMap } = batchRead;

		// Phase 3: Create new PRs (one mutation)
		ui.heading("\nCreating/updating PRs...");
		const createBatch = new MutationBatch(repoNodeId);
		const createAliases = new Map<string, number>(); // alias -> branch index

		for (let i = 0; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch || branch.pr != null) continue;
			const base =
				i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);
			const title = this.deriveTitle(branch.name);
			const alias = `create_${i}`;
			createBatch.createPR(alias, {
				base,
				head: branch.name,
				title,
				body: "",
				draft: true,
			});
			createAliases.set(alias, i);
		}

		// Map of nodeIds for all PRs (existing + newly created) for comment phase
		const prNodeIds = new Map<number, string>();
		for (const [num, details] of prDetailsMap) {
			prNodeIds.set(num, details.nodeId);
		}

		if (!createBatch.isEmpty) {
			const createResult = createBatch.flush();

			// Check for errors but don't bail — partial success is OK
			for (const err of createResult.errors) {
				const path = err.path?.join(".") ?? "";
				ui.error(`Create failed (${path}): ${err.message}`);
			}

			for (const [alias, branchIndex] of createAliases) {
				const created = createResult.data[alias] as
					| { pullRequest: { id: string; number: number; url: string } }
					| undefined;
				const branch = stack.branches[branchIndex];
				if (!branch) continue;
				if (created?.pullRequest) {
					branch.pr = created.pullRequest.number;
					prNodeIds.set(created.pullRequest.number, created.pullRequest.id);
					ui.success(
						`Created ${theme.pr(`#${created.pullRequest.number}`)} for ${theme.branch(branch.name)} (draft)`,
					);
				} else {
					ui.error(`Failed to create PR for ${theme.branch(branch.name)}`);
					// branch.pr stays null — no comment will be posted for it
				}
			}
		}

		// Phase 4: Compute skip decisions
		const prStatuses = new Map<number, PrStatus>();

		// Existing PRs: map PRDetails -> PrStatus
		for (const [num, details] of prDetailsMap) {
			prStatuses.set(num, {
				number: details.number,
				title: details.title,
				state: details.state,
				isDraft: details.isDraft,
				url: details.url,
				reviewDecision: details.reviewDecision,
			});
		}

		// Newly created PRs: synthesize PrStatus
		for (const [_alias, branchIndex] of createAliases) {
			const branch = stack.branches[branchIndex];
			if (!branch?.pr) continue;
			if (prStatuses.has(branch.pr)) continue; // already set
			const created = prNodeIds.get(branch.pr);
			if (!created) continue;
			prStatuses.set(branch.pr, {
				number: branch.pr,
				title: this.deriveTitle(branch.name),
				state: "OPEN",
				isDraft: true,
				url: `${repoUrl}/pull/${branch.pr}`,
				reviewDecision: "",
			});
		}

		// Phase 5: Execute updates + comments (one mutation)
		const updateBatch = new MutationBatch(repoNodeId);
		const baseUpdates: Array<{ pr: number; base: string; alias: string }> = [];
		const commentUpdates: Array<{ pr: number; alias: string }> = [];

		for (let i = 0; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch?.pr) continue;

			const desiredBase =
				i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);
			const existing = prDetailsMap.get(branch.pr);
			const nodeId = prNodeIds.get(branch.pr);
			if (!nodeId) continue;

			// Base update — skip if unchanged
			if (existing && existing.baseRefName === desiredBase) {
				ui.info(`  \u2191 ${theme.pr(`#${branch.pr}`)} base unchanged`);
			} else {
				const alias = `update_${i}`;
				updateBatch.updatePRBase(alias, nodeId, desiredBase);
				baseUpdates.push({ pr: branch.pr, base: desiredBase, alias });
			}

			// Comment — skip if identical
			const comment = generateComment(stack, branch.pr, prStatuses, repoUrl);
			if (existing?.botComment?.body === comment) {
				// Comment identical — skip silently
			} else if (existing?.botComment) {
				const alias = `editcomment_${i}`;
				updateBatch.updateComment(alias, existing.botComment.nodeId, comment);
				commentUpdates.push({ pr: branch.pr, alias });
			} else {
				const alias = `addcomment_${i}`;
				updateBatch.addComment(alias, nodeId, comment);
				commentUpdates.push({ pr: branch.pr, alias });
			}
		}

		if (!updateBatch.isEmpty) {
			try {
				const updateResult = updateBatch.flush();
				const failedPaths = new Set(
					updateResult.errors.map((e) => e.path?.[0] ?? ""),
				);

				for (const upd of baseUpdates) {
					if (failedPaths.has(upd.alias)) {
						ui.warn(`Failed to update ${theme.pr(`#${upd.pr}`)} base`);
					} else {
						ui.success(
							`Updated ${theme.pr(`#${upd.pr}`)} base to ${theme.branch(upd.base)}`,
						);
					}
				}
				for (const upd of commentUpdates) {
					if (failedPaths.has(upd.alias)) {
						ui.warn(
							`Failed to update comment on ${theme.pr(`#${upd.pr}`)}`,
						);
					} else {
						ui.success(
							`Updated stack comment on ${theme.pr(`#${upd.pr}`)}`,
						);
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ui.warn(`Failed to flush updates: ${msg}`);
			}
		}

		// Phase 6: Save state, restore branch, report
		stack.updated = new Date().toISOString();
		saveState(state);

		try {
			git.checkout(originalBranch);
		} catch {
			// If we can't restore, that's ok — user can switch manually
		}

		process.stderr.write("\n");
		ui.success(
			`Submitted stack ${theme.stack(stackName)} (${stack.branches.length} PRs)`,
		);
		for (let i = 0; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch) continue;
			const prStr = branch.pr != null ? theme.pr(`#${branch.pr}`) : "no PR";
			ui.info(`  ${i + 1}. ${theme.branch(branch.name)} \u2192 ${prStr}`);
		}
		return 0;
	}

	private deriveTitle(branchName: string): string {
		const parsed = parseBranchName(branchName);
		if (parsed) {
			return descriptionToTitle(parsed.description);
		}
		// Fallback: last commit subject
		const subjects = git.log(`${branchName}~1..${branchName}`, "%s");
		const subject = subjects[0];
		if (subject) return subject;
		// Last resort: branch name
		return branchName;
	}
}
