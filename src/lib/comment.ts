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

  // Render top-of-stack first (last branch in array = top)
  const entries: string[] = [];

  for (let i = stack.branches.length - 1; i >= 0; i--) {
    const branch = stack.branches[i];
    if (!branch) continue;

    const prRef = branch.pr != null ? `#${branch.pr}` : branch.name;
    const isCurrent = branch.pr === currentPrNumber;

    entries.push(isCurrent ? `**${prRef}** 👈` : prRef);
  }

  // Trunk at the bottom
  entries.push(`\`${stack.trunk}\``);

  // Join with arrow separators showing merge direction
  lines.push(entries.join('\n\n↓\n\n'));

  lines.push('');
  lines.push('<sub>Managed by Claude Code <code>/stack</code></sub>');

  return lines.join('\n');
}
