import type { CheckStatus } from './merge-display.js';

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

/** Fetch status checks for a single PR via GraphQL. */
export function fetchCheckStatus(
	owner: string,
	repo: string,
	prNumber: number,
): CheckStatus[] {
	const query = `query {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
      pullRequest(number: ${prNumber}) {
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 50) {
                  nodes {
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      startedAt
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

	const result = exec('api', 'graphql', '-f', `query=${query}`);
	if (!result.ok) {
		return [];
	}

	const parsed = JSON.parse(result.stdout) as {
		data: {
			repository: {
				pullRequest: {
					commits: {
						nodes: Array<{
							commit: {
								statusCheckRollup: {
									contexts: {
										nodes: Array<
											| {
													name: string;
													status: string;
													conclusion: string | null;
													startedAt: string | null;
											  }
											| {
													context: string;
													state: string;
											  }
										>;
									};
								} | null;
							};
						}>;
					};
				};
			};
		};
	};

	const commitNode = parsed.data.repository.pullRequest.commits.nodes[0];
	if (!commitNode) return [];

	const rollup = commitNode.commit.statusCheckRollup;
	if (!rollup) return [];

	const checks: CheckStatus[] = [];
	for (const node of rollup.contexts.nodes) {
		if ('name' in node) {
			// CheckRun
			checks.push({
				name: node.name,
				status: mapCheckRunStatus(node.status),
				conclusion: mapConclusion(node.conclusion),
				startedAt: node.startedAt ?? undefined,
			});
		} else if ('context' in node) {
			// StatusContext
			checks.push({
				name: node.context,
				...mapStatusContextState(node.state),
			});
		}
	}

	return checks;
}

function mapCheckRunStatus(
	status: string,
): CheckStatus['status'] {
	switch (status) {
		case 'COMPLETED':
			return 'completed';
		case 'IN_PROGRESS':
			return 'in_progress';
		default:
			return 'queued';
	}
}

function mapConclusion(
	conclusion: string | null,
): CheckStatus['conclusion'] {
	if (!conclusion) return null;
	switch (conclusion) {
		case 'SUCCESS':
			return 'success';
		case 'FAILURE':
		case 'TIMED_OUT':
		case 'CANCELLED':
			return 'failure';
		case 'NEUTRAL':
			return 'neutral';
		case 'SKIPPED':
			return 'skipped';
		default:
			return null;
	}
}

function mapStatusContextState(
	state: string,
): Pick<CheckStatus, 'status' | 'conclusion'> {
	switch (state) {
		case 'SUCCESS':
			return { status: 'completed', conclusion: 'success' };
		case 'FAILURE':
		case 'ERROR':
			return { status: 'completed', conclusion: 'failure' };
		case 'PENDING':
		case 'EXPECTED':
		default:
			return { status: 'in_progress', conclusion: null };
	}
}
