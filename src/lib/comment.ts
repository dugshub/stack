import { parseBranchName } from './branch.js';
import { buildReport } from './stack-report.js';
import { findDependentStacks, primaryParent } from './state.js';
import type { PrStatus, Stack, StackFile, StatusEmoji } from './types.js';
import { aggregateStatusEmoji, statusEmoji, statusTextForEmoji } from './ui.js';

/** Marker used to identify stack navigation comments posted by the bot. */
export const COMMENT_MARKER = '### PR Stack';

export interface NeighborBranch {
  pr: number | null;
  prUrl: string | null;
  title: string;
  status: StatusEmoji;
}

export interface NeighborStack {
  name: string;
  branchCount: number;
  aggregateStatus: StatusEmoji;
  direction: 'upstream' | 'downstream';
  branches: NeighborBranch[];
}

export interface NeighborContext {
  neighbors: NeighborStack[];
  rootTrunk: string;
}

export interface NeighborChainResult {
  upstream: NeighborStack[];
  downstream: NeighborStack[];
  rootTrunk: string;
}

export function collectNeighborChain(
  state: StackFile,
  currentStackName: string,
  prStatuses: Map<number, PrStatus>,
  depth: number = 3,
  repoUrl: string = '',
): NeighborChainResult {
  const upstream: NeighborStack[] = [];
  const downstream: NeighborStack[] = [];
  const visited = new Set<string>([currentStackName]);

  // Walk upstream via primaryParent
  let currentName = currentStackName;
  let rootTrunk = state.stacks[currentStackName]?.trunk ?? 'main';
  for (let level = 0; level < depth; level++) {
    const stack = state.stacks[currentName];
    if (!stack) break;
    const parent = primaryParent(stack);
    if (!parent) break;
    const parentStack = state.stacks[parent.stack];
    if (!parentStack || visited.has(parent.stack)) break;
    visited.add(parent.stack);

    const neighborBranches: NeighborBranch[] = parentStack.branches.map(b => {
      const pr = b.pr != null ? prStatuses.get(b.pr) ?? null : null;
      return {
        pr: b.pr,
        prUrl: b.pr != null ? `${repoUrl}/pull/${b.pr}` : null,
        title: pr?.title ?? '',
        status: statusEmoji(pr),
      };
    });
    const emojis = neighborBranches.map(b => b.status);
    const agg = aggregateStatusEmoji(emojis);

    upstream.push({
      name: parent.stack,
      branchCount: parentStack.branches.length,
      aggregateStatus: agg,
      direction: 'upstream',
      branches: neighborBranches,
    });

    rootTrunk = parentStack.trunk;
    currentName = parent.stack;
  }

  // Walk downstream via BFS using findDependentStacks
  let queue = [currentStackName];
  for (let level = 0; level < depth; level++) {
    const nextQueue: string[] = [];
    for (const name of queue) {
      const dependents = findDependentStacks(state, name);
      for (const dep of dependents) {
        if (visited.has(dep.name)) continue;
        visited.add(dep.name);

        const neighborBranches: NeighborBranch[] = dep.stack.branches.map(b => {
          const pr = b.pr != null ? prStatuses.get(b.pr) ?? null : null;
          return {
            pr: b.pr,
            prUrl: b.pr != null ? `${repoUrl}/pull/${b.pr}` : null,
            title: pr?.title ?? '',
            status: statusEmoji(pr),
          };
        });
        const emojis = neighborBranches.map(b => b.status);
        const agg = aggregateStatusEmoji(emojis);

        downstream.push({
          name: dep.name,
          branchCount: dep.stack.branches.length,
          aggregateStatus: agg,
          direction: 'downstream',
          branches: neighborBranches,
        });

        nextQueue.push(dep.name);
      }
    }
    if (nextQueue.length === 0) break;
    queue = nextQueue;
  }

  return { upstream, downstream, rootTrunk };
}

export function generateComment(
  stack: Stack,
  currentPrNumber: number,
  prStatuses: Map<number, PrStatus>,
  repoUrl: string,
  neighborCtx?: NeighborContext,
): string {
  const report = buildReport(stack, currentPrNumber, prStatuses, repoUrl);

  // Extract stack name from prefix or fall back to parsing a branch
  let stackLabel = '';
  if (report.prefix) {
    // e.g. "dugshub/test-mergedown/" -> "test-mergedown"
    const segments = report.prefix.replace(/\/$/, '').split('/');
    stackLabel = segments.length >= 2 ? (segments[1] ?? '') : (segments[0] ?? '');
  }
  if (!stackLabel && report.rows.length > 0) {
    const parsed = parseBranchName(report.rows[0]!.fullName);
    stackLabel = parsed?.stack ?? '';
  }

  const lines: string[] = [];

  const header = stackLabel
    ? `${COMMENT_MARKER} \`${stackLabel}\``
    : COMMENT_MARKER;
  lines.push(header);
  lines.push('');
  lines.push('| Status | PR | Title |');
  lines.push('|--------|-----|-------|');

  // Downstream neighbor rows (outermost first, so reverse the array)
  const downstreamNeighbors = neighborCtx?.neighbors.filter(n => n.direction === 'downstream') ?? [];
  if (downstreamNeighbors.length > 0) {
    const reversed = [...downstreamNeighbors].reverse();
    for (const neighbor of reversed) {
      // Header row for the neighbor stack
      lines.push(`| | **\u2196 \`${neighbor.name}\`** | |`);
      // Render individual branch rows (top of stack first)
      for (let i = neighbor.branches.length - 1; i >= 0; i--) {
        const nb = neighbor.branches[i]!;
        const statusCell = `${nb.status} ${statusTextForEmoji(nb.status)}`;
        const prLink = nb.pr != null ? `[#${nb.pr}](${nb.prUrl})` : '';
        lines.push(`| ${statusCell} | \u00A0\u00A0\u00A0${prLink} | ${nb.title} |`);
      }
    }
  }

  // Render top-of-stack first (reverse order)
  for (let i = report.rows.length - 1; i >= 0; i--) {
    const row = report.rows[i]!;

    const prLink = row.pr != null
      ? `[#${row.pr}](${row.prUrl})`
      : '';
    const pointer = row.isCurrent ? ' \u{1F448}' : '';

    const statusCell = `${row.status} ${row.statusText}`;
    const prCell = row.isCurrent ? `**${prLink}**` : prLink;
    const titleCell = row.isCurrent ? `**${row.title}**${pointer}` : row.title;

    lines.push(`| ${statusCell} | ${prCell} | ${titleCell} |`);
  }

  // Upstream neighbors + trunk row
  const upstreamNeighbors = neighborCtx?.neighbors.filter(n => n.direction === 'upstream') ?? [];
  if (upstreamNeighbors.length > 0) {
    // Render upstream neighbors (immediate parent first, then deeper ancestors)
    for (const neighbor of upstreamNeighbors) {
      // Header row for the neighbor stack
      lines.push(`| | **\u21B3 \`${neighbor.name}\`** | |`);
      // Render individual branch rows (top of stack first)
      for (let i = neighbor.branches.length - 1; i >= 0; i--) {
        const nb = neighbor.branches[i]!;
        const statusCell = `${nb.status} ${statusTextForEmoji(nb.status)}`;
        const prLink = nb.pr != null ? `[#${nb.pr}](${nb.prUrl})` : '';
        lines.push(`| ${statusCell} | \u00A0\u00A0\u00A0${prLink} | ${nb.title} |`);
      }
    }
    // Then render trunk using rootTrunk from neighbor context
    lines.push(`| | \`${neighborCtx!.rootTrunk}\` | |`);
  } else if (report.dependsOn) {
    lines.push(`| | \u21B3 \`${report.dependsOn.stack}\`${report.dependsOn.pos} | |`);
  } else {
    lines.push(`| | \`${report.trunk}\` | |`);
  }

  lines.push('');
  lines.push('<sub>Managed by <a href="https://github.com/dugshub/stack">stack CLI</a></sub>');

  return lines.join('\n');
}
