import { COMMENT_MARKER } from './comment.js';

interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

function exec(...args: string[]): RunResult {
	const result = Bun.spawnSync(["gh", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
		exitCode: result.exitCode,
	};
}

// ── Batch Read ─────────────────────────────────────────

export interface PRDetails {
	number: number;
	nodeId: string;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	url: string;
	reviewDecision: string;
	baseRefName: string;
	botComment: {
		nodeId: string;
		body: string;
	} | null;
}

export interface BatchReadResult {
	repoNodeId: string;
	viewerLogin: string;
	prs: Map<number, PRDetails>;
}

export function fetchPRDetails(
	owner: string,
	repo: string,
	prNumbers: number[],
): BatchReadResult {
	const prAliases = prNumbers
		.map(
			(n) =>
				`pr_${n}: pullRequest(number: ${n}) {
        id
        number
        title
        state
        isDraft
        url
        reviewDecision
        baseRefName
        comments(last: 30) {
          nodes {
            id
            body
            author { login }
          }
        }
      }`,
		)
		.join("\n      ");

	const query = `query {
    viewer { login }
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
      id
      ${prAliases}
    }
  }`;

	const result = exec("api", "graphql", "-f", `query=${query}`);
	if (!result.ok) {
		throw new Error(
			`GraphQL batch read failed (exit ${result.exitCode}): ${result.stderr}`,
		);
	}

	const parsed = JSON.parse(result.stdout) as {
		data: {
			viewer: { login: string };
			repository: Record<
				string,
				| string
				| {
						id: string;
						number: number;
						title: string;
						state: "OPEN" | "CLOSED" | "MERGED";
						isDraft: boolean;
						url: string;
						reviewDecision: string | null;
						baseRefName: string;
						comments: {
							nodes: Array<{
								id: string;
								body: string;
								author: { login: string } | null;
							}>;
						};
				  }
			>;
		};
	};

	const viewerLogin = parsed.data.viewer.login;
	const repoData = parsed.data.repository;
	const repoNodeId = repoData.id as string;

	const prs = new Map<number, PRDetails>();
	for (const [key, value] of Object.entries(repoData)) {
		if (!key.startsWith("pr_") || typeof value === "string") continue;
		if (!value || typeof value.number !== "number") continue;

		// Find the last bot comment with our marker
		let botComment: PRDetails["botComment"] = null;
		for (const comment of value.comments.nodes) {
			if (
				comment.author?.login === viewerLogin &&
				comment.body.includes(COMMENT_MARKER)
			) {
				botComment = {
					nodeId: comment.id,
					body: comment.body,
				};
			}
		}

		prs.set(value.number, {
			number: value.number,
			nodeId: value.id,
			title: value.title,
			state: value.state,
			isDraft: value.isDraft,
			url: value.url,
			reviewDecision: value.reviewDecision ?? "",
			baseRefName: value.baseRefName,
			botComment,
		});
	}

	return { repoNodeId, viewerLogin, prs };
}

// ── Mutation Batch ─────────────────────────────────────

export interface MutationResult {
	data: Record<string, unknown>;
	errors: Array<{ message: string; path?: string[] }>;
}

interface MutationEntry {
	alias: string;
	body: string;
}

export class MutationBatch {
	private entries: MutationEntry[] = [];

	constructor(private repoNodeId: string) {}

	createPR(
		alias: string,
		opts: {
			base: string;
			head: string;
			title: string;
			body: string;
			draft: boolean;
		},
	): this {
		this.entries.push({
			alias,
			body: `createPullRequest(input: {
      repositoryId: ${JSON.stringify(this.repoNodeId)}
      baseRefName: ${JSON.stringify(opts.base)}
      headRefName: ${JSON.stringify(opts.head)}
      title: ${JSON.stringify(opts.title)}
      body: ${JSON.stringify(opts.body)}
      draft: ${opts.draft}
    }) {
      pullRequest { id number url }
    }`,
		});
		return this;
	}

	updatePRBody(alias: string, prNodeId: string, body: string): this {
		this.entries.push({
			alias,
			body: `updatePullRequest(input: {
      pullRequestId: ${JSON.stringify(prNodeId)}
      body: ${JSON.stringify(body)}
    }) {
      pullRequest { id number }
    }`,
		});
		return this;
	}

	updatePRBase(alias: string, prNodeId: string, base: string): this {
		this.entries.push({
			alias,
			body: `updatePullRequest(input: {
      pullRequestId: ${JSON.stringify(prNodeId)}
      baseRefName: ${JSON.stringify(base)}
    }) {
      pullRequest { id number }
    }`,
		});
		return this;
	}

	addComment(alias: string, subjectNodeId: string, body: string): this {
		this.entries.push({
			alias,
			body: `addComment(input: {
      subjectId: ${JSON.stringify(subjectNodeId)}
      body: ${JSON.stringify(body)}
    }) {
      commentEdge { node { id } }
    }`,
		});
		return this;
	}

	updateComment(alias: string, commentNodeId: string, body: string): this {
		this.entries.push({
			alias,
			body: `updateIssueComment(input: {
      id: ${JSON.stringify(commentNodeId)}
      body: ${JSON.stringify(body)}
    }) {
      issueComment { id }
    }`,
		});
		return this;
	}

	get size(): number {
		return this.entries.length;
	}

	get isEmpty(): boolean {
		return this.entries.length === 0;
	}

	flush(): MutationResult {
		const aliases = this.entries
			.map((e) => `${e.alias}: ${e.body}`)
			.join("\n  ");

		const mutation = `mutation {\n  ${aliases}\n}`;

		const result = exec("api", "graphql", "-f", `query=${mutation}`);

		if (!result.ok && result.stdout.length === 0) {
			throw new Error(
				`GraphQL mutation failed (exit ${result.exitCode}): ${result.stderr}`,
			);
		}

		const parsed = JSON.parse(result.stdout) as {
			data?: Record<string, unknown>;
			errors?: Array<{ message: string; path?: string[] }>;
		};

		return {
			data: parsed.data ?? {},
			errors: parsed.errors ?? [],
		};
	}
}
