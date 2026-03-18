import { parseBranchName } from './branch.js';
import type { PrStatus, Stack } from './types.js';
import { statusEmoji, statusText } from './ui.js';

/** Marker used to identify stack navigation comments posted by the bot. */
export const COMMENT_MARKER = '### PR Stack';

export function generateComment(
  stack: Stack,
  currentPrNumber: number,
  prStatuses: Map<number, PrStatus>,
  repoUrl: string,
): string {
  const lines: string[] = [];

  lines.push(COMMENT_MARKER);
  lines.push('');
  lines.push('| Status | PR | Title |');
  lines.push('|--------|-----|-------|');

  // Render top-of-stack first (last branch in array = top)
  for (let i = stack.branches.length - 1; i >= 0; i--) {
    const branch = stack.branches[i];
    if (!branch) continue;

    const pr = branch.pr != null ? (prStatuses.get(branch.pr) ?? null) : null;
    const isCurrent = branch.pr === currentPrNumber;
    const emoji = statusEmoji(pr);
    const text = statusText(pr);
    const prLink = branch.pr != null
      ? `[#${branch.pr}](${repoUrl}/pull/${branch.pr})`
      : '';
    const title = pr?.title ?? '';
    const pointer = isCurrent ? ' 👈' : '';

    const statusCell = `${emoji} ${text}`;
    const prCell = isCurrent ? `**${prLink}**` : prLink;
    const titleCell = isCurrent ? `**${title}**${pointer}` : title;

    lines.push(`| ${statusCell} | ${prCell} | ${titleCell} |`);
  }

  // Trunk row
  if (stack.dependsOn) {
    const parsed = parseBranchName(stack.dependsOn.branch);
    const pos = parsed ? ` #${parsed.index}` : '';
    lines.push(`| | ↳ \`${stack.dependsOn.stack}\`${pos} | |`);
  } else {
    lines.push(`| | \`${stack.trunk}\` | |`);
  }

  lines.push('');
  lines.push('<sub>Managed by Claude Code <code>/stack</code></sub>');

  return lines.join('\n');
}
