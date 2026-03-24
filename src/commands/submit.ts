import { Command, Option } from "clipanion";
import { descriptionToTitle, parseBranchName } from "../lib/branch.js";
import { generateComment } from "../lib/comment.js";
import * as gh from "../lib/gh.js";
import * as git from "../lib/git.js";
import {
	type BatchReadResult,
	fetchPRDetails,
	MutationBatch,
} from "../lib/graphql.js";
import { resolveStack } from "../lib/resolve.js";
import { loadAndRefreshState, saveState } from "../lib/state.js";
import { theme } from "../lib/theme.js";
import type { PrStatus } from "../lib/types.js";
import { saveSnapshot } from "../lib/undo.js";
import * as ui from "../lib/ui.js";

export class SubmitCommand extends Command {
	static override paths = [["stack", "submit"], ["submit"]];

	static override usage = Command.Usage({
		description: "Push branches and create/update PRs for the stack",
		examples: [
			["Show what would happen", "st submit --dry-run"],
			["Push and create/update PRs", "st submit"],
		],
	});

	stackName = Option.String("--stack,-s", {
		description: "Target stack by name",
	});

	dryRun = Option.Boolean("--dry-run", false, {
		description: "Show what would happen without making changes",
	});

	ready = Option.Boolean("--ready", false, {
		description: "Mark all PRs as ready for review (not draft)",
	});

	describe = Option.Boolean("--describe", {
		description: "Generate PR descriptions with AI via Anthropic API (default: from config)",
	});

	update = Option.Boolean("--update", false, {
		description: "Regenerate AI descriptions for existing PRs",
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();

		let resolved: Awaited<ReturnType<typeof resolveStack>>;
		try {
			resolved = await resolveStack({ state, explicitName: this.stackName });
		} catch (err) {
			ui.error(err instanceof Error ? err.message : String(err));
			return 2;
		}

		const { stackName: resolvedName, stack, position } = resolved;

		if (this.dryRun) {
			return this.showDryRun(stack, resolvedName);
		}

		let useDescribe = this.update || (this.describe ?? state.config?.describe ?? false);

		if (useDescribe) {
			const { ensureAuth } = await import("../lib/ai/pr-description.js");
			const hasAuth = await ensureAuth();
			if (!hasAuth) {
				ui.warn("Not logged in. Using default PR descriptions.");
				useDescribe = false;
			}
		}

		return this.fullSubmit(state, stack, resolvedName, position, useDescribe, this.update);
	}

	private showDryRun(
		stack: ReturnType<typeof loadAndRefreshState>["stacks"][string] & object,
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
			`\nRun ${theme.command("st submit")} to proceed.\n`,
		);
		return 0;
	}

	private async fullSubmit(
		state: ReturnType<typeof loadAndRefreshState>,
		stack: ReturnType<typeof loadAndRefreshState>["stacks"][string] & object,
		stackName: string,
		position: import("../lib/types.js").StackPosition | null,
		useDescribe: boolean,
		updateExisting = false,
	): Promise<number> {
		saveSnapshot('submit');
		const originalBranch = position ? git.currentBranch() : null;
		const repoUrl = `https://github.com/${state.repo}`;

		// Phase 1: Push (only changed branches, in parallel)
		ui.heading("\nPushing branches...");
		const pushPlans: git.PushPlan[] = [];
		const upToDate: string[] = [];

		for (const branch of stack.branches) {
			if (!git.needsPush(branch.name)) {
				upToDate.push(branch.name);
				continue;
			}
			pushPlans.push({
				branch: branch.name,
				mode: git.hasRemoteRef(branch.name) ? 'force-with-lease' : 'new',
			});
		}

		for (const name of upToDate) {
			ui.info(`  \u2191 ${theme.branch(name)} (up to date)`);
		}

		if (pushPlans.length > 0) {
			const pushResults = await git.pushParallel("origin", pushPlans);
			for (const result of pushResults) {
				if (result.ok) {
					const plan = pushPlans.find(p => p.branch === result.branch);
					const suffix = plan?.mode === 'new' ? ' (new)' : '';
					ui.success(`Pushed ${theme.branch(result.branch)}${suffix}`);
				} else {
					ui.error(
						`Push failed for ${theme.branch(result.branch)}: ${result.error ?? 'unknown error'}`,
					);
					return 2;
				}
			}
		}

		for (const branch of stack.branches) {
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

		// Collect branches that need PRs — first check if any already exist on GitHub
		const branchesWithoutPR = stack.branches
			.map((b, i) => ({ branch: b, index: i }))
			.filter(({ branch }) => branch && branch.pr == null);

		if (branchesWithoutPR.length > 0) {
			// Check GitHub for existing open PRs matching these head branches
			const headNames = branchesWithoutPR.map(({ branch }) => branch.name);
			const existingPRs = gh.findPRsByHead(state.repo, headNames);
			for (const { branch } of branchesWithoutPR) {
				const found = existingPRs.get(branch.name);
				if (found) {
					branch.pr = found;
					ui.info(`  Adopted existing ${theme.pr(`#${found}`)} for ${theme.branch(branch.name)}`);
				}
			}
			if (existingPRs.size > 0) saveState(state);
		}

		const toCreate: Array<{ index: number; branch: typeof stack.branches[0]; base: string; title: string }> = [];
		for (let i = 0; i < stack.branches.length; i++) {
			const branch = stack.branches[i];
			if (!branch || branch.pr != null) continue;
			const base = i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);
			toCreate.push({ index: i, branch, base, title: this.deriveTitle(branch.name) });
		}

		// Generate AI descriptions in parallel (if enabled)
		const createBodies = new Map<number, string>();
		if (useDescribe && toCreate.length > 0) {
			const { generatePrDescription } = await import("../lib/ai/pr-description.js");
			ui.info(`  Generating ${toCreate.length} PR description${toCreate.length > 1 ? 's' : ''}...`);
			const results = await Promise.allSettled(
				toCreate.map(({ index, branch, base }) =>
					generatePrDescription({
						baseBranch: base,
						headBranch: branch.name,
						stackName,
						branchIndex: index,
						totalBranches: stack.branches.length,
					}).then((body) => ({ index, body })),
				),
			);
			for (const result of results) {
				if (result.status === "fulfilled") {
					createBodies.set(result.value.index, result.value.body);
				} else {
					const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
					ui.warn(`  AI description failed: ${msg}. Using default.`);
				}
			}
		}

		for (const { index, branch, base, title } of toCreate) {
			const body = createBodies.get(index) ?? this.generatePrBody(index, stack.branches.length, stackName);
			const alias = `create_${index}`;
			createBatch.createPR(alias, { base, head: branch.name, title, body, draft: true });
			createAliases.set(alias, index);
		}

		// Track newly created PR numbers for --ready suggestion
		const newPRNumbers = new Set<number>();

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
					newPRNumbers.add(created.pullRequest.number);
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
				checksStatus: null,
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
				checksStatus: null,
			});
		}

		// Phase 5: Update descriptions for existing PRs (if --update)
		if (updateExisting && useDescribe) {
			const descBatch = new MutationBatch(repoNodeId);
			const descUpdates: Array<{ pr: number; alias: string }> = [];

			// Collect branches to update
			const toUpdate: Array<{ index: number; branch: typeof stack.branches[0]; base: string; nodeId: string }> = [];
			for (let i = 0; i < stack.branches.length; i++) {
				const branch = stack.branches[i];
				if (!branch?.pr) continue;
				const nodeId = prNodeIds.get(branch.pr);
				if (!nodeId) continue;
				const base = i === 0 ? stack.trunk : (stack.branches[i - 1]?.name ?? stack.trunk);
				toUpdate.push({ index: i, branch, base, nodeId });
			}

			if (toUpdate.length > 0) {
				const { generatePrDescription } = await import("../lib/ai/pr-description.js");
				ui.info(`  Generating ${toUpdate.length} PR description${toUpdate.length > 1 ? 's' : ''} in parallel...`);

				const results = await Promise.allSettled(
					toUpdate.map(({ index, branch, base }) =>
						generatePrDescription({
							baseBranch: base,
							headBranch: branch.name,
							stackName,
							branchIndex: index,
							totalBranches: stack.branches.length,
						}).then((body) => ({ index, body })),
					),
				);

				for (const result of results) {
					if (result.status === "fulfilled") {
						const { index, body } = result.value;
						const item = toUpdate.find((u) => u.index === index)!;
						const alias = `desc_${index}`;
						descBatch.updatePRBody(alias, item.nodeId, body);
						descUpdates.push({ pr: item.branch.pr!, alias });
					} else {
						const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
						ui.warn(`  AI description failed: ${msg}`);
					}
				}
			}

			if (!descBatch.isEmpty) {
				try {
					const result = descBatch.flush();
					const failedPaths = new Set(
						result.errors.map((e) => e.path?.[0] ?? ""),
					);
					for (const upd of descUpdates) {
						if (failedPaths.has(upd.alias)) {
							ui.warn(`Failed to update description on ${theme.pr(`#${upd.pr}`)}`);
						} else {
							ui.success(`Updated description on ${theme.pr(`#${upd.pr}`)}`);
						}
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ui.warn(`Failed to update descriptions: ${msg}`);
				}
			}
		}

		// Phase 6: Execute updates + comments (one mutation)
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

		if (originalBranch) {
			try {
				git.checkout(originalBranch);
			} catch {
				// If we can't restore, that's ok — user can switch manually
			}
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

		// Mark PRs as ready if --ready flag is set
		if (this.ready) {
			for (const branch of stack.branches) {
				if (branch.pr != null) {
					const details = prDetailsMap.get(branch.pr);
					// Only call ready on PRs that are drafts (new PRs are always drafts)
					if (!details || details.isDraft) {
						try {
							gh.prReady(branch.pr);
							ui.success(`Marked #${branch.pr} as ready for review`);
						} catch {
							ui.warn(`Could not mark #${branch.pr} as ready`);
						}
					}
				}
			}
		}

		if (!this.ready) {
			const hasDrafts = newPRNumbers.size > 0 || stack.branches.some((b) => {
				if (b.pr == null) return false;
				const details = prDetailsMap.get(b.pr);
				return details?.isDraft;
			});
			if (hasDrafts) {
				ui.info(`\nTip: Use ${theme.command('st submit --ready')} to mark draft PRs as ready for review.`);
			}
		}

		// One-time hint about AI descriptions
		if (
			!useDescribe &&
			state.config?.describe == null &&
			!state.config?.describeHintDismissed
		) {
			ui.info(
				`Tip: Use ${theme.command("st submit --describe")} to generate PR descriptions with AI`,
			);
			if (!state.config) state.config = {};
			state.config.describeHintDismissed = true;
			saveState(state);
		}

		// Update merge-ready statuses
		gh.updateMergeReadyStatuses(state.repo, stack.branches, stack.trunk);

		return 0;
	}

	private generatePrBody(branchIndex: number, totalBranches: number, stackName: string): string {
		const position = `PR ${branchIndex + 1} of ${totalBranches}`;
		return `**Stack:** \`${stackName}\` (${position})\n\n---\n*🤖 Generated with [Claude Code](https://claude.com/claude-code)*`;
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
