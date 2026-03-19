import type { MergeStrategy, PrStatus } from './types.js';

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
    'number,title,state,isDraft,url,reviewDecision,statusCheckRollup',
  );
  if (!result.ok) return null;
  const raw = JSON.parse(result.stdout) as Record<string, unknown>;
  const rollup = raw.statusCheckRollup as Array<{ state: string; name?: string; context?: string }> | null;
  // gh pr view returns statusCheckRollup as an array of individual checks
  // Filter out our own stack/* checks so they don't pollute the CI status
  const checks = rollup?.filter((c) => {
    const id = c.name ?? c.context ?? '';
    return !id.startsWith('stack/');
  });
  // Derive overall state: any failure = FAILURE, all success = SUCCESS, else PENDING
  let checksStatus: PrStatus['checksStatus'] = null;
  if (checks && checks.length > 0) {
    if (checks.some((c) => c.state === 'FAILURE' || c.state === 'ERROR')) {
      checksStatus = 'FAILURE';
    } else if (checks.every((c) => c.state === 'SUCCESS')) {
      checksStatus = 'SUCCESS';
    } else {
      checksStatus = 'PENDING';
    }
  }
  return { ...raw, checksStatus } as PrStatus;
}

export function prViewBatch(prNumbers: number[]): Map<number, PrStatus> {
	if (prNumbers.length === 0) return new Map();

	const fullName = repoFullName();
	const [owner, name] = fullName.split('/');

	const fields = `number title state isDraft url reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 100) { nodes {
          ... on CheckRun { name conclusion status }
          ... on StatusContext { context state }
        } }
      } } } }`;
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
		data: { repository: Record<string, { number: number; title: string; state: string; isDraft: boolean; url: string; reviewDecision: string | null; commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: Array<{ name?: string; conclusion?: string; status?: string; context?: string; state?: string }> } } | null } }> } }> };
	};

	const statuses = new Map<number, PrStatus>();
	for (const entry of Object.values(data.data.repository)) {
		if (entry && typeof entry.number === 'number') {
			const rollup = entry.commits?.nodes?.[0]?.commit?.statusCheckRollup;
			const contexts = rollup?.contexts?.nodes?.filter((c) => {
				const id = c.name ?? c.context ?? '';
				return !id.startsWith('stack/');
			});
			let checksStatus: PrStatus['checksStatus'] = null;
			if (contexts && contexts.length > 0) {
				// CheckRun uses conclusion/status; StatusContext uses state
				const hasFailure = contexts.some((c) => {
					if (c.conclusion) return c.conclusion === 'FAILURE' || c.conclusion === 'ERROR';
					return c.state === 'FAILURE' || c.state === 'ERROR';
				});
				const allSuccess = contexts.every((c) => {
					if (c.conclusion) return c.conclusion === 'SUCCESS';
					return c.state === 'SUCCESS';
				});
				checksStatus = hasFailure ? 'FAILURE' : allSuccess ? 'SUCCESS' : 'PENDING';
			}
			statuses.set(entry.number, {
				number: entry.number,
				title: entry.title,
				state: entry.state as PrStatus['state'],
				isDraft: entry.isDraft,
				url: entry.url,
				reviewDecision: entry.reviewDecision ?? '',
				checksStatus,
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

export function prEdit(prNumber: number, opts: { base?: string; title?: string }): void {
  const args = ['pr', 'edit', String(prNumber)];
  if (opts.base) {
    args.push('--base', opts.base);
  }
  if (opts.title) {
    args.push('--title', opts.title);
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

export function prReady(prNumber: number): void {
  run('pr', 'ready', String(prNumber));
}

/**
 * Post merge-ready commit statuses for all open PRs in a stack.
 * The bottom-most open PR gets "success"; others get "failure".
 */
export function updateMergeReadyStatuses(
  repo: string,
  branches: Array<{ name: string; pr: number | null; tip: string | null }>,
): void {
  const withPRs = branches.filter((b) => b.pr != null && b.tip);
  if (withPRs.length === 0) return;

  // Batch-check which PRs are still open
  const prNumbers = withPRs.map((b) => b.pr as number);
  const [owner, name] = repo.split('/');
  const result = exec(
    'api', 'graphql',
    '-f', `query=query {
      repository(owner: "${owner}", name: "${name}") {
        ${prNumbers.map((n, i) => `pr${i}: pullRequest(number: ${n}) { number state }`).join('\n')}
      }
    }`,
  );
  if (!result.ok) return;

  const data = JSON.parse(result.stdout) as {
    data: { repository: Record<string, { number: number; state: string }> };
  };
  const openPRs = new Set<number>();
  for (const pr of Object.values(data.data.repository)) {
    if (pr && pr.state === 'OPEN') openPRs.add(pr.number);
  }

  // Find first open PR — that's the merge-ready one
  let firstOpenPR: number | null = null;
  for (const branch of branches) {
    if (branch.pr != null && openPRs.has(branch.pr)) {
      firstOpenPR = branch.pr;
      break;
    }
  }

  // Post statuses
  for (const branch of withPRs) {
    if (!openPRs.has(branch.pr as number)) continue;
    const sha = branch.tip as string;
    const isReady = branch.pr === firstOpenPR;
    exec(
      'api', `repos/${repo}/statuses/${sha}`,
      '-f', `state=${isReady ? 'success' : 'failure'}`,
      '-f', 'context=stack/merge-ready',
      '-f', `description=${isReady ? 'Ready to merge (next in stack)' : `Waiting for PR #${firstOpenPR} to merge first`}`,
    );
  }
}

export function repoSettings(): { deleteBranchOnMerge: boolean; allowAutoMerge: boolean; visibility: string } {
  const result = exec(
    'api',
    'repos/{owner}/{repo}',
    '--jq',
    '[.delete_branch_on_merge, .allow_auto_merge, .visibility] | @tsv',
  );
  if (!result.ok) {
    return { deleteBranchOnMerge: false, allowAutoMerge: false, visibility: 'unknown' };
  }
  const [deleteBranch, autoMerge, visibility] = result.stdout.split('\t');
  return {
    deleteBranchOnMerge: deleteBranch === 'true',
    allowAutoMerge: autoMerge === 'true',
    visibility: visibility ?? 'unknown',
  };
}
