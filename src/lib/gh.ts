import type { MergeStrategy } from '../server/types.js';
import type { PrStatus } from './types.js';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function exec(...args: string[]): RunResult {
  const result = Bun.spawnSync(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

function run(...args: string[]): string {
  const result = exec(...args);
  if (!result.ok) {
    throw new Error(
      `gh ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

export function repoFullName(): string {
  return run('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner');
}

export function currentUser(): string {
  return run('api', 'user', '-q', '.login');
}

export function prView(prNumber: number): PrStatus | null {
  const result = exec(
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,state,isDraft,url,reviewDecision',
  );
  if (!result.ok) return null;
  return JSON.parse(result.stdout) as PrStatus;
}

export function prViewBatch(prNumbers: number[]): Map<number, PrStatus> {
	if (prNumbers.length === 0) return new Map();

	const fullName = repoFullName();
	const [owner, name] = fullName.split('/');

	const fields = 'number title state isDraft url reviewDecision';
	const aliases = prNumbers
		.map(
			(n) =>
				`pr_${n}: pullRequest(number: ${n}) { ${fields} }`,
		)
		.join('\n      ');

	const query = `query {
    repository(owner: "${owner}", name: "${name}") {
      ${aliases}
    }
  }`;

	const result = exec('api', 'graphql', '-f', `query=${query}`);
	if (!result.ok) return new Map();

	const data = JSON.parse(result.stdout) as {
		data: { repository: Record<string, { number: number; title: string; state: string; isDraft: boolean; url: string; reviewDecision: string | null }> };
	};

	const statuses = new Map<number, PrStatus>();
	for (const entry of Object.values(data.data.repository)) {
		if (entry && typeof entry.number === 'number') {
			statuses.set(entry.number, {
				number: entry.number,
				title: entry.title,
				state: entry.state as PrStatus['state'],
				isDraft: entry.isDraft,
				url: entry.url,
				reviewDecision: entry.reviewDecision ?? '',
			});
		}
	}
	return statuses;
}

export function prCreate(opts: {
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}): number {
  const args = [
    'pr',
    'create',
    '--base',
    opts.base,
    '--head',
    opts.head,
    '--title',
    opts.title,
    '--body',
    opts.body,
  ];
  if (opts.draft) args.push('--draft');
  const output = run(...args);
  const match = output.match(/\/(\d+)\s*$/);
  if (!match?.[1]) {
    throw new Error(`Could not parse PR number from: ${output}`);
  }
  return Number.parseInt(match[1], 10);
}

export function prEdit(prNumber: number, opts: { base?: string }): void {
  const args = ['pr', 'edit', String(prNumber)];
  if (opts.base) {
    args.push('--base', opts.base);
  }
  run(...args);
}

export function prComment(prNumber: number, body: string): void {
  run(
    'pr',
    'comment',
    String(prNumber),
    '--body',
    body,
    '--edit-last',
    '--create-if-none',
  );
}

export function prClose(prNumber: number): void {
  run('pr', 'close', String(prNumber));
}

export function prList(head: string): number | null {
  const result = exec(
    'pr',
    'list',
    '--head',
    head,
    '--json',
    'number',
    '-q',
    '.[0].number',
  );
  if (!result.ok || result.stdout.length === 0) return null;
  const num = Number.parseInt(result.stdout, 10);
  return Number.isNaN(num) ? null : num;
}

export function prMergeAuto(
	prNumber: number,
	opts: { strategy: MergeStrategy },
): { ok: boolean; error?: string } {
	const strategyFlag =
		opts.strategy === 'squash'
			? '--squash'
			: opts.strategy === 'rebase'
				? '--rebase'
				: '--merge';
	const result = exec(
		'pr',
		'merge',
		String(prNumber),
		'--auto',
		strategyFlag,
	);
	if (!result.ok) {
		return { ok: false, error: result.stderr };
	}
	return { ok: true };
}

export function prMergeAutoDisable(
	prNumber: number,
): { ok: boolean; error?: string } {
	const result = exec('pr', 'merge', String(prNumber), '--disable-auto');
	if (!result.ok) {
		return { ok: false, error: result.stderr };
	}
	return { ok: true };
}

export function repoSettings(): { deleteBranchOnMerge: boolean } {
  const result = exec(
    'api',
    'repos/{owner}/{repo}',
    '-q',
    '.delete_branch_on_merge',
  );
  return {
    deleteBranchOnMerge: result.ok && result.stdout === 'true',
  };
}
