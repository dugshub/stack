import type { PrStatus, Stack } from './types.js';
import { statusEmoji, statusText } from './ui.js';

export function generateComment(
  stack: Stack,
  currentPrNumber: number,
  prStatuses: Map<number, PrStatus>,
  repoUrl: string,
): string {
  const lines: string[] = [];

  lines.push('### PR Stack');
  lines.push('');
  lines.push('| # | Branch | PR | Status |');
  lines.push('|---|--------|-----|--------|');

  for (let i = 0; i < stack.branches.length; i++) {
    const branch = stack.branches[i];
    if (!branch) continue;

    const pr = branch.pr != null ? (prStatuses.get(branch.pr) ?? null) : null;
    const emoji = statusEmoji(pr);
    const text = statusText(pr);
    const prLink =
      branch.pr != null ? `[#${branch.pr}](${repoUrl}/pull/${branch.pr})` : '';
    const isCurrent = branch.pr === currentPrNumber;

    const idx = isCurrent ? `**${i + 1}**` : `${i + 1}`;
    const name = isCurrent ? `**${branch.name}**` : branch.name;
    const prCell = isCurrent && prLink ? `**${prLink}**` : prLink;
    const statusCell = isCurrent ? `**${emoji} ${text}**` : `${emoji} ${text}`;

    lines.push(`| ${idx} | ${name} | ${prCell} | ${statusCell} |`);
  }

  lines.push('');
  lines.push('<sub>Managed by Claude Code <code>/stack</code></sub>');

  return lines.join('\n');
}
