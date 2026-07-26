import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { gh, GitHubError, seg } from "./github";
import { compactComment, compactIssue, compactLabel } from "./shape";

/**
 * Builds an MCP server bound to a single PAT. A fresh instance is created per
 * request, so the token lives only as long as the request that supplied it.
 */
export function createGitHubIssuesServer(pat: string, login: string): McpServer {
	const server = new McpServer({
		name: "github-issues",
		version: "1.0.0",
	});

	interface ToolConfig {
		description: string;
		inputSchema: z.ZodRawShape;
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			idempotentHint?: boolean;
			openWorldHint?: boolean;
		};
	}

	/** Wraps a handler so GitHub failures surface as tool errors, not exceptions. */
	function register(name: string, config: ToolConfig, handler: (args: any) => Promise<unknown>) {
		// `registerTool` is generic over its schema shape, which does not survive
		// being funnelled through one helper — the zod schemas above each handler
		// remain the real contract, and they are what actually validate input.
		(server.registerTool as any)(name, config, async (args: any): Promise<CallToolResult> => {
			try {
				const data = await handler(args);
				return {
					structuredContent: data as Record<string, unknown>,
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			} catch (error) {
				const message =
					error instanceof GitHubError || error instanceof Error
						? error.message
						: String(error);
				return { isError: true, content: [{ type: "text", text: message }] };
			}
		});
	}

	const repoShape = {
		owner: z.string().describe("Repository owner — a user or organisation login"),
		repo: z.string().describe("Repository name"),
	};

	const paging = {
		per_page: z.number().int().min(1).max(100).default(30),
		page: z.number().int().min(1).default(1),
	};

	/** Builds the `/repos/{owner}/{repo}` prefix with both segments escaped. */
	const repoPath = (a: { owner: string; repo: string }) =>
		`/repos/${seg(a.owner)}/${seg(a.repo)}`;

	// ---------------------------------------------------------------- identity

	register(
		"whoami",
		{
			annotations: { readOnlyHint: true },
			description:
				"Show which GitHub account the current token belongs to. Useful for confirming the connector is wired up correctly.",
			inputSchema: {},
		},
		async () => {
			const user = await gh<any>(pat, "/user");
			return {
				login: user.login,
				name: user.name ?? undefined,
				type: user.type,
				authorised_as: login,
			};
		},
	);

	// ------------------------------------------------------------------ issues

	register(
		"list_issues",
		{
			annotations: { readOnlyHint: true },
			description:
				"List issues in a repository. Pull requests are excluded by default because GitHub's issues endpoint returns them alongside real issues.",
			inputSchema: {
				...repoShape,
				state: z.enum(["open", "closed", "all"]).default("open"),
				labels: z
					.array(z.string())
					.optional()
					.describe("Only issues carrying ALL of these labels"),
				assignee: z
					.string()
					.optional()
					.describe("Filter by assignee login, or 'none' / '*' for unassigned / any"),
				creator: z
					.string()
					.optional()
					.describe("Filter by the login that opened the issue"),
				milestone: z
					.string()
					.optional()
					.describe("Milestone number, or '*' for any, or 'none' for issues without one"),
				since: z
					.string()
					.optional()
					.describe("Only issues updated at or after this ISO 8601 timestamp"),
				sort: z.enum(["created", "updated", "comments"]).default("created"),
				direction: z.enum(["asc", "desc"]).default("desc"),
				include_prs: z.boolean().default(false),
				...paging,
			},
		},
		async (a) => {
			const raw = await gh<any[]>(pat, `${repoPath(a)}/issues`, {
				query: {
					state: a.state,
					labels: a.labels?.length ? a.labels.join(",") : undefined,
					assignee: a.assignee,
					creator: a.creator,
					milestone: a.milestone,
					since: a.since,
					sort: a.sort,
					direction: a.direction,
					per_page: a.per_page,
					page: a.page,
				},
			});

			const issues = raw
				.filter((issue) => a.include_prs || !issue.pull_request)
				.map(compactIssue);

			return { count: issues.length, page: a.page, issues };
		},
	);

	register(
		"get_issue",
		{
			annotations: { readOnlyHint: true },
			description: "Fetch a single issue by number, including its full body.",
			inputSchema: {
				...repoShape,
				issue_number: z.number().int().positive(),
			},
		},
		async (a) => compactIssue(await gh<any>(pat, `${repoPath(a)}/issues/${a.issue_number}`)),
	);

	register(
		"search_issues",
		{
			annotations: { readOnlyHint: true },
			description:
				"Search issues and pull requests across GitHub using search syntax. Scope the query with qualifiers such as `repo:owner/name`, `is:open`, `label:bug`, or `author:login` — without them this searches all of GitHub. Note this endpoint has its own rate limit of 30 requests per minute.",
			inputSchema: {
				q: z
					.string()
					.describe("Search query, e.g. 'repo:owner/name is:issue is:open label:bug'"),
				sort: z
					.enum(["comments", "reactions", "created", "updated"])
					.optional()
					.describe("Omit to sort by best match"),
				order: z.enum(["asc", "desc"]).default("desc"),
				...paging,
			},
		},
		async (a) => {
			const found = await gh<any>(pat, "/search/issues", {
				query: {
					q: a.q,
					sort: a.sort,
					order: a.order,
					per_page: a.per_page,
					page: a.page,
					advanced_search: true,
				},
			});

			return {
				total_count: found.total_count,
				incomplete_results: found.incomplete_results,
				issues: (found.items ?? []).map(compactIssue),
			};
		},
	);

	register(
		"create_issue",
		{
			annotations: { destructiveHint: false },
			description: "Open a new issue in a repository.",
			inputSchema: {
				...repoShape,
				title: z.string().min(1),
				body: z.string().optional().describe("Issue body in GitHub-flavoured Markdown"),
				labels: z.array(z.string()).optional(),
				assignees: z.array(z.string()).optional().describe("GitHub logins to assign"),
				milestone: z.number().int().optional().describe("Milestone number, not its title"),
				type: z
					.string()
					.optional()
					.describe("Issue type name, if the org has types enabled"),
			},
		},
		async (a) =>
			compactIssue(
				await gh<any>(pat, `${repoPath(a)}/issues`, {
					method: "POST",
					body: {
						title: a.title,
						body: a.body,
						labels: a.labels,
						assignees: a.assignees,
						milestone: a.milestone,
						type: a.type,
					},
				}),
			),
	);

	register(
		"update_issue",
		{
			annotations: { destructiveHint: true },
			description:
				"Update an existing issue. This is also how issues are closed and reopened, via `state` and `state_reason`. Take care: `labels` and `assignees` REPLACE the existing sets rather than adding to them — use add_issue_labels / remove_issue_label to adjust labels incrementally.",
			inputSchema: {
				...repoShape,
				issue_number: z.number().int().positive(),
				title: z.string().min(1).optional(),
				body: z.string().optional(),
				state: z.enum(["open", "closed"]).optional(),
				state_reason: z
					.enum(["completed", "not_planned", "reopened"])
					.optional()
					.describe("Why the issue was closed or reopened"),
				labels: z.array(z.string()).optional().describe("REPLACES all existing labels"),
				assignees: z
					.array(z.string())
					.optional()
					.describe("REPLACES all existing assignees"),
				milestone: z
					.number()
					.int()
					.nullable()
					.optional()
					.describe("Milestone number, or null to clear it"),
				type: z.string().nullable().optional(),
			},
		},
		async (a) =>
			compactIssue(
				await gh<any>(pat, `${repoPath(a)}/issues/${a.issue_number}`, {
					method: "PATCH",
					body: {
						title: a.title,
						body: a.body,
						state: a.state,
						state_reason: a.state_reason,
						labels: a.labels,
						assignees: a.assignees,
						milestone: a.milestone,
						type: a.type,
					},
				}),
			),
	);

	// ---------------------------------------------------------------- comments

	register(
		"list_issue_comments",
		{
			annotations: { readOnlyHint: true },
			description: "List the comments on an issue, oldest first.",
			inputSchema: {
				...repoShape,
				issue_number: z.number().int().positive(),
				since: z
					.string()
					.optional()
					.describe("Only comments updated at or after this ISO 8601 timestamp"),
				...paging,
			},
		},
		async (a) => {
			const raw = await gh<any[]>(pat, `${repoPath(a)}/issues/${a.issue_number}/comments`, {
				query: { since: a.since, per_page: a.per_page, page: a.page },
			});
			return {
				count: raw.length,
				page: a.page,
				comments: raw.map(compactComment),
			};
		},
	);

	register(
		"add_issue_comment",
		{
			annotations: { destructiveHint: false },
			description: "Post a new comment on an issue.",
			inputSchema: {
				...repoShape,
				issue_number: z.number().int().positive(),
				body: z.string().min(1).describe("Comment body in GitHub-flavoured Markdown"),
			},
		},
		async (a) =>
			compactComment(
				await gh<any>(pat, `${repoPath(a)}/issues/${a.issue_number}/comments`, {
					method: "POST",
					body: { body: a.body },
				}),
			),
	);

	register(
		"update_issue_comment",
		{
			annotations: { destructiveHint: true },
			description:
				"Edit an existing comment. Takes the comment's own id — from list_issue_comments — not the issue number.",
			inputSchema: {
				...repoShape,
				comment_id: z.number().int().positive(),
				body: z.string().min(1),
			},
		},
		async (a) =>
			compactComment(
				await gh<any>(pat, `${repoPath(a)}/issues/comments/${a.comment_id}`, {
					method: "PATCH",
					body: { body: a.body },
				}),
			),
	);

	// ------------------------------------------------------------------ labels

	register(
		"list_labels",
		{
			annotations: { readOnlyHint: true },
			description:
				"List every label defined in a repository. Worth calling before labelling an issue, since GitHub rejects labels that do not already exist.",
			inputSchema: { ...repoShape, ...paging },
		},
		async (a) => {
			const raw = await gh<any[]>(pat, `${repoPath(a)}/labels`, {
				query: { per_page: a.per_page, page: a.page },
			});
			return { count: raw.length, labels: raw.map(compactLabel) };
		},
	);

	register(
		"add_issue_labels",
		{
			annotations: { destructiveHint: false },
			description: "Add labels to an issue, leaving its existing labels in place.",
			inputSchema: {
				...repoShape,
				issue_number: z.number().int().positive(),
				labels: z.array(z.string()).min(1),
			},
		},
		async (a) => {
			const raw = await gh<any[]>(pat, `${repoPath(a)}/issues/${a.issue_number}/labels`, {
				method: "POST",
				body: { labels: a.labels },
			});
			return { labels: raw.map(compactLabel) };
		},
	);

	register(
		"remove_issue_label",
		{
			annotations: { destructiveHint: true },
			description: "Remove a single label from an issue, leaving its other labels in place.",
			inputSchema: {
				...repoShape,
				issue_number: z.number().int().positive(),
				label: z.string().min(1),
			},
		},
		async (a) => {
			const raw = await gh<any[]>(
				pat,
				`${repoPath(a)}/issues/${a.issue_number}/labels/${seg(a.label)}`,
				{ method: "DELETE" },
			);
			return { labels: (raw ?? []).map(compactLabel) };
		},
	);

	return server;
}
