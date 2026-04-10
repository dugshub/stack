import { parseBranchName } from './branch.js';
import { buildReport } from './stack-report.js';
import type { PrStatus, Stack } from './types.js';

/** Marker used to identify stack navigation comments posted by the bot. */
export const COMMENT_MARKER = '### PR Stack';

export function generateComment(
  stack: Stack,
  currentPrNumber: number,
  prStatuses: Map<number, PrStatus>,
  repoUrl: string,
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

  // Trunk row
  if (report.dependsOn) {
    lines.push(`| | \u21B3 \`${report.dependsOn.stack}\`${report.dependsOn.pos} | |`);
  } else {
    lines.push(`| | \`${report.trunk}\` | |`);
  }

  lines.push('');
  lines.push('<sub>Managed by <a href="https://github.com/dugshub/stack">stack CLI</a></sub>');

  return lines.join('\n');
}
