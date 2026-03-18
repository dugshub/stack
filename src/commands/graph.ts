import { Command } from 'clipanion';
import * as gh from '../lib/gh.js';
import { tryDaemonCache } from '../lib/daemon-client.js';
import { findActiveStack, findDependentStacks, loadAndRefreshState } from '../lib/state.js';
import type { PrStatus, Stack, StackFile } from '../lib/types.js';
import * as ui from '../lib/ui.js';
import type { GraphNode } from '../lib/ui.js';

export class GraphCommand extends Command {
	static override paths = [['graph']];

	static override usage = Command.Usage({
		description: 'Show dependency graph across all stacks',
		examples: [
			['Show the full stack graph', 'stack graph'],
		],
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();
		const stackNames = Object.keys(state.stacks);

		if (stackNames.length === 0) {
			ui.info('No tracked stacks.');
			return 0;
		}

		// Determine current stack
		const position = findActiveStack(state);
		const currentStackName = position?.stackName ?? null;

		// Fetch PR statuses for all stacks
		const prStatuses = await this.fetchAllPrStatuses(state);

		// Build the graph: group stacks by trunk, nesting dependents under parents
		const roots = buildGraph(state, currentStackName, prStatuses);

		process.stderr.write('\n');
		ui.heading('Stack graph:\n');
		ui.stackGraph(roots, currentStackName);
		process.stderr.write('\n');

		return 0;
	}

	private async fetchAllPrStatuses(
		state: StackFile,
	): Promise<Map<number, PrStatus>> {
		// Collect all PR numbers across all stacks
		const allPrNumbers: number[] = [];
		for (const stack of Object.values(state.stacks)) {
			for (const branch of stack.branches) {
				if (branch.pr != null) {
					allPrNumbers.push(branch.pr);
				}
			}
		}

		if (allPrNumbers.length === 0) return new Map();

		// Try daemon cache first
		const fullName = state.repo || gh.repoFullName();
		const [owner, repoName] = fullName.split('/');
		let prStatuses = owner && repoName
			? await tryDaemonCache(owner, repoName)
			: null;
		if (!prStatuses) {
			prStatuses = gh.prViewBatch(allPrNumbers);
		}

		return prStatuses;
	}
}

function buildGraph(
	state: StackFile,
	currentStackName: string | null,
	prStatuses: Map<number, PrStatus>,
): Array<{ trunk: string; children: GraphNode[] }> {
	// Group root stacks (not dependent on another stack) by trunk
	const trunkGroups = new Map<string, Array<{ name: string; stack: Stack }>>();
	for (const [name, stack] of Object.entries(state.stacks)) {
		if (stack.dependsOn?.stack) continue; // Skip dependent stacks — they'll be nested
		const trunk = stack.trunk;
		let group = trunkGroups.get(trunk);
		if (!group) {
			group = [];
			trunkGroups.set(trunk, group);
		}
		group.push({ name, stack });
	}

	// Build tree recursively
	const roots: Array<{ trunk: string; children: GraphNode[] }> = [];
	for (const [trunk, stacks] of trunkGroups) {
		const children: GraphNode[] = [];
		for (const { name, stack } of stacks) {
			children.push(
				buildNodeRecursive(state, name, stack, currentStackName, prStatuses),
			);
		}
		roots.push({ trunk, children });
	}

	return roots;
}

function buildNodeRecursive(
	state: StackFile,
	stackName: string,
	stack: Stack,
	currentStackName: string | null,
	prStatuses: Map<number, PrStatus>,
): GraphNode {
	// Compute aggregate status from all branches
	const emojis = stack.branches.map((b) => {
		const pr = b.pr != null ? (prStatuses.get(b.pr) ?? null) : null;
		return ui.statusEmoji(pr);
	});
	const aggregateStatus = ui.aggregateStatusEmoji(emojis);

	// Find dependent stacks and recurse
	const dependents = findDependentStacks(state, stackName);
	const children: GraphNode[] = [];
	for (const { name: depName, stack: depStack } of dependents) {
		children.push(
			buildNodeRecursive(state, depName, depStack, currentStackName, prStatuses),
		);
	}

	return {
		name: stackName,
		trunk: stack.trunk,
		branchCount: stack.branches.length,
		aggregateStatus,
		isCurrent: stackName === currentStackName,
		children,
	};
}
