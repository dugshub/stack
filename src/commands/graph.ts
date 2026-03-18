import { Command, Option } from 'clipanion';
import * as gh from '../lib/gh.js';
import { tryDaemonCache } from '../lib/daemon-client.js';
import { findActiveStack, findDependentStacks, loadAndRefreshState } from '../lib/state.js';
import { findCommonPrefix } from '../lib/stack-report.js';
import type { Branch, PrStatus, Stack, StackFile } from '../lib/types.js';
import * as ui from '../lib/ui.js';
import type { GraphStackNode } from '../lib/ui.js';

export class GraphCommand extends Command {
	static override paths = [['graph']];

	static override usage = Command.Usage({
		description: 'Show dependency graph across all stacks',
		examples: [
			['Show stack graph (expand current stack)', 'stack graph'],
			['Expand all stacks', 'stack graph --expand'],
		],
	});

	expand = Option.Boolean('--expand,-e', false, {
		description: 'Expand all stacks to show branches',
	});

	async execute(): Promise<number> {
		const state = loadAndRefreshState();
		const stackNames = Object.keys(state.stacks);

		if (stackNames.length === 0) {
			ui.info('No tracked stacks.');
			return 0;
		}

		const position = findActiveStack(state);
		const currentStackName = position?.stackName ?? null;
		const currentBranchName = position?.branch.name ?? null;

		const prStatuses = await this.fetchAllPrStatuses(state);

		const roots = buildGraph(
			state,
			currentStackName,
			currentBranchName,
			prStatuses,
			this.expand,
		);

		process.stderr.write('\n');
		ui.renderStackGraph(roots);
		process.stderr.write('\n');

		return 0;
	}

	private async fetchAllPrStatuses(
		state: StackFile,
	): Promise<Map<number, PrStatus>> {
		const allPrNumbers: number[] = [];
		for (const stack of Object.values(state.stacks)) {
			for (const branch of stack.branches) {
				if (branch.pr != null) {
					allPrNumbers.push(branch.pr);
				}
			}
		}

		if (allPrNumbers.length === 0) return new Map();

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

interface GraphRoot {
	trunk: string;
	stacks: GraphStackNode[];
}

function buildGraph(
	state: StackFile,
	currentStackName: string | null,
	currentBranchName: string | null,
	prStatuses: Map<number, PrStatus>,
	expandAll: boolean,
): GraphRoot[] {
	// Group root stacks (not dependent on another stack) by trunk
	const trunkGroups = new Map<string, Array<{ name: string; stack: Stack }>>();
	for (const [name, stack] of Object.entries(state.stacks)) {
		if (stack.dependsOn?.stack) continue;
		const trunk = stack.trunk;
		let group = trunkGroups.get(trunk);
		if (!group) {
			group = [];
			trunkGroups.set(trunk, group);
		}
		group.push({ name, stack });
	}

	const roots: GraphRoot[] = [];
	for (const [trunk, stacks] of trunkGroups) {
		const nodes: GraphStackNode[] = [];
		for (const { name, stack } of stacks) {
			nodes.push(
				buildStackNode(state, name, stack, currentStackName, currentBranchName, prStatuses, expandAll),
			);
		}
		roots.push({ trunk, stacks: nodes });
	}

	return roots;
}

function buildStackNode(
	state: StackFile,
	stackName: string,
	stack: Stack,
	currentStackName: string | null,
	currentBranchName: string | null,
	prStatuses: Map<number, PrStatus>,
	expandAll: boolean,
): GraphStackNode {
	const isCurrent = stackName === currentStackName;
	const expanded = expandAll || isCurrent;

	// Compute aggregate status
	const emojis = stack.branches.map((b) => {
		const pr = b.pr != null ? (prStatuses.get(b.pr) ?? null) : null;
		return ui.statusEmoji(pr);
	});
	const aggregateStatus = ui.aggregateStatusEmoji(emojis);

	// Find dependent stacks that fork from branches in this stack
	const dependents = findDependentStacks(state, stackName);

	// Build a map: branch name -> dependent stack nodes that fork from it
	const forkMap = new Map<string, GraphStackNode[]>();
	for (const { name: depName, stack: depStack } of dependents) {
		const forkBranch = depStack.dependsOn?.branch ?? '';
		let list = forkMap.get(forkBranch);
		if (!list) {
			list = [];
			forkMap.set(forkBranch, list);
		}
		list.push(
			buildStackNode(state, depName, depStack, currentStackName, currentBranchName, prStatuses, expandAll),
		);
	}

	// Compute common prefix for short branch names
	const prefix = expanded
		? findCommonPrefix(stack.branches.map((b) => b.name))
		: '';

	// Build branch info for expanded view
	const branches = expanded
		? stack.branches.map((b: Branch) => {
			const pr = b.pr != null ? (prStatuses.get(b.pr) ?? null) : null;
			const shortName = prefix ? b.name.slice(prefix.length) : b.name;
			return {
				name: b.name,
				shortName,
				pr: b.pr,
				prStatus: pr,
				isCurrent: b.name === currentBranchName,
				dependents: forkMap.get(b.name) ?? [],
			};
		})
		: undefined;

	// For collapsed view, collect all dependents into a flat children array
	const children = expanded
		? undefined
		: dependents.map(({ name: depName, stack: depStack }) =>
			buildStackNode(state, depName, depStack, currentStackName, currentBranchName, prStatuses, expandAll),
		);

	return {
		name: stackName,
		prefix,
		branchCount: stack.branches.length,
		aggregateStatus,
		isCurrent,
		expanded,
		branches,
		children,
	};
}
