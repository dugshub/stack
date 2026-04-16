import { parseBranchName } from './branch.js';
import { buildReport } from './stack-report.js';
import { findCommonPrefix } from './stack-report.js';
import { findDependentStacks, primaryParent } from './state.js';
import type { PrStatus, Stack, StackFile, StatusEmoji } from './types.js';
import { aggregateStatusEmoji, statusEmoji, statusTextForEmoji } from './ui.js';

/** Marker used to identify stack navigation comments posted by the bot. */
export const COMMENT_MARKER = '### PR Stack';

// Tree-drawing characters (matching CLI graph)
const DOT_STACK = '\u25CF';    // ●
const DOT_BRANCH = '\u25CB';   // ○
const DOT_CURRENT = '\u25C9';  // ◉
const DOT_TRUNK = '\u25C7';    // ◇
const FORK_MID = '\u251C';     // ├
const FORK_END = '\u2570';     // ╰
const DASH = '\u2500';         // ─

export interface NeighborBranch {
  shortName: string;
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

    const prefix = findCommonPrefix(parentStack.branches.map(b => b.name));
    const neighborBranches: NeighborBranch[] = parentStack.branches.map(b => {
      const pr = b.pr != null ? prStatuses.get(b.pr) ?? null : null;
      return {
        shortName: prefix ? b.name.slice(prefix.length) : b.name,
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

        const prefix = findCommonPrefix(dep.stack.branches.map(b => b.name));
        const neighborBranches: NeighborBranch[] = dep.stack.branches.map(b => {
          const pr = b.pr != null ? prStatuses.get(b.pr) ?? null : null;
          return {
            shortName: prefix ? b.name.slice(prefix.length) : b.name,
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

interface TreeSection {
  name: string;
  isCurrentStack: boolean;
  branches: TreeBranch[];
}

interface TreeBranch {
  shortName: string;
  pr: number | null;
  prUrl: string | null;
  statusEmoji: string;
  statusText: string;
  isCurrentPr: boolean;
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
    const segments = report.prefix.replace(/\/$/, '').split('/');
    stackLabel = segments.length >= 2 ? (segments[1] ?? '') : (segments[0] ?? '');
  }
  if (!stackLabel && report.rows.length > 0) {
    const parsed = parseBranchName(report.rows[0]!.fullName);
    stackLabel = parsed?.stack ?? '';
  }

  // Build sections: upstream (deepest ancestor first) → current → downstream
  const sections: TreeSection[] = [];
  const upstreamNeighbors = neighborCtx?.neighbors.filter(n => n.direction === 'upstream') ?? [];
  const downstreamNeighbors = neighborCtx?.neighbors.filter(n => n.direction === 'downstream') ?? [];

  // Upstream reversed so deepest ancestor renders first (top of tree)
  for (const neighbor of [...upstreamNeighbors].reverse()) {
    sections.push({
      name: neighbor.name,
      isCurrentStack: false,
      branches: neighbor.branches.map(nb => ({
        shortName: nb.shortName,
        pr: nb.pr,
        prUrl: nb.prUrl,
        statusEmoji: nb.status,
        statusText: statusTextForEmoji(nb.status),
        isCurrentPr: false,
      })),
    });
  }

  // Current stack
  sections.push({
    name: stackLabel,
    isCurrentStack: true,
    branches: report.rows.map(row => ({
      shortName: row.shortName,
      pr: row.pr,
      prUrl: row.prUrl,
      statusEmoji: row.status,
      statusText: row.statusText,
      isCurrentPr: row.isCurrent,
    })),
  });

  // Downstream
  for (const neighbor of downstreamNeighbors) {
    sections.push({
      name: neighbor.name,
      isCurrentStack: false,
      branches: neighbor.branches.map(nb => ({
        shortName: nb.shortName,
        pr: nb.pr,
        prUrl: nb.prUrl,
        statusEmoji: nb.status,
        statusText: statusTextForEmoji(nb.status),
        isCurrentPr: false,
      })),
    });
  }

  // Determine trunk
  const trunk = neighborCtx?.rootTrunk ?? report.trunk;

  // Render tree
  const lines: string[] = [];
  const header = stackLabel
    ? `${COMMENT_MARKER} \`${stackLabel}\``
    : COMMENT_MARKER;
  lines.push(header);
  lines.push('');
  lines.push('<pre>');
  lines.push(`${DOT_TRUNK} ${trunk}`);

  let stackIndent = '';
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;

    // Stack header
    const nameHtml = section.isCurrentStack
      ? `<b>${section.name}</b>`
      : section.name;
    lines.push(`${stackIndent}${FORK_END}${DASH} ${DOT_STACK} ${nameHtml}`);

    const branchIndent = stackIndent + '   ';

    // Column widths for alignment
    const nameW = Math.max(4, ...section.branches.map(b => b.shortName.length));
    const prW = Math.max(0, ...section.branches.map(b => b.pr != null ? `#${b.pr}`.length : 0));

    for (let i = 0; i < section.branches.length; i++) {
      const b = section.branches[i]!;
      const isLast = i === section.branches.length - 1;
      const connector = isLast ? `${FORK_END}${DASH}` : `${FORK_MID}${DASH}`;
      const dot = b.isCurrentPr ? DOT_CURRENT : DOT_BRANCH;
      const paddedName = b.shortName.padEnd(nameW);

      let prPart = '';
      if (b.pr != null && b.prUrl) {
        const prText = `#${b.pr}`;
        const padded = prText.padEnd(prW);
        prPart = `<a href="${b.prUrl}">${padded}</a>`;
      } else {
        prPart = ''.padEnd(prW);
      }

      const statusPart = `${b.statusEmoji} ${b.statusText}`;
      const marker = b.isCurrentPr ? '  \u25C0 this PR' : '';

      lines.push(`${branchIndent}${connector} ${dot} ${paddedName}  ${prPart}  ${statusPart}${marker}`);
    }

    // Next section indents under the last branch
    stackIndent = branchIndent + '   ';
  }

  lines.push('</pre>');
  lines.push('');
  lines.push('<sub>Managed by <a href="https://github.com/dugshub/stack">stack CLI</a></sub>');

  return lines.join('\n');
}
