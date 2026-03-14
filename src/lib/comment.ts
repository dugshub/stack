import type { Stack } from './types.js';

/** Marker used to identify stack navigation comments posted by the bot. */
export const COMMENT_MARKER = '### PR Stack';

export function generateComment(
  stack: Stack,
  currentPrNumber: number,
  _prStatuses: Map<number, unknown>,
  _repoUrl: string,
): string {
  const lines: string[] = [];

  lines.push(COMMENT_MARKER);
  lines.push('');

  for (let i = 0; i < stack.branches.length; i++) {
    const branch = stack.branches[i];
    if (!branch) continue;

    const isCurrent = branch.pr === currentPrNumber;
    const prRef = branch.pr != null ? `#${branch.pr}` : '';
    const marker = isCurrent ? ' 👈' : '';
    const line = isCurrent
      ? `* **${prRef}**${marker}`
      : `* ${prRef}`;

    lines.push(line);
  }

  lines.push(`* \`${stack.trunk}\``);
  lines.push('');
  lines.push('<sub>Managed by Claude Code <code>/stack</code></sub>');

  return lines.join('\n');
}
