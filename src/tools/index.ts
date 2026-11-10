import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkQuota, recordUsage } from "../db/usage";
import { gh, ghGraphQL, seg } from "../github/client";
import { compactComment, compactIssue, compactLabel, compactPullRequest } from "../shape";
import {
	type ToolConfig,
	type ToolContext,
	actAs,
	explain,
	paging,
	ranAs,
	repoPath,
	repoShape,
	scrub,
	withClosingKeywords,
} from "./common";
import { registerSecurityTools } from "./security";

/**
 * The only thing REST cannot tell us about a pull request. `closingIssuesReferences`
 * is the read side of the link that closing keywords create.
 */
const CLOSING_ISSUES_QUERY = `
	query ($owner: String!, $repo: String!, $number: Int!) {
		repository(owner: $owner, name: $repo) {
			pullRequest(number: $number) {
				closingIssuesReferences(first: 50) {
					nodes { number }
				}
			}
		}
	}
`;

/**
 * Builds an MCP server bound to a single connection's credentials. A fresh
 * instance is created per request, so the tokens live only as long as the
 * request that supplied them.
 */
export function createGitHubIssuesServer(ctx: ToolContext): McpServer {
	const server = new McpServer({
		name: "github-issues",
		version: "2.0.0",
	});

	/** Wraps a handler so GitHub failures surface as tool errors, not exceptions. */
	function register(name: string, config: ToolConfig, handler: (args: any) => Promise<unknown>) {
		// `registerTool` is generic over its schema shape, which does not survive
		// being funnelled through one helper — the zod schemas above each handler
		// remain the real contract, and they are what actually validate input.
		(server.registerTool as any)(name, config, async (args: any): Promise<CallToolResult> => {
			// Counted whether or not it succeeds: a failed call still costs a GitHub
			// round trip. Deferred so metering never sits in the latency path.
			ctx.waitUntil(recordUsage(ctx.env, ctx.tenant.installationId, "tool_call"));

			try {
				const data = await handler(args);
				return {
					structuredContent: data as Record<string, unknown>,
					content: [{ type: "text", text: scrub(JSON.stringify(data, null, 2)) }],
				};
			} catch (error) {
				const identity = ranAs(config.inputSchema, args);
				const text = scrub(explain(error, args, ctx.tenant, name, identity));
				return { isError: true, content: [{ type: "text", text }] };
			}
		});
	}

	// ---------------------------------------------------------------- identity

	register(
		"whoami",
		{
			annotations: { readOnlyHint: true },
			description:
				"Show both GitHub identities this connection can act as — the app's bot account " +
				"and the signed-in person — plus which repositories the app can reach. Useful " +
				"for confirming the connector is wired up correctly and for deciding what to " +
				"pass as act_as.",
			inputSchema: {},
		},
		async () => {
			// Reported side by side rather than as one call, because a half-broken
			// connection is exactly when you most want this tool to still answer.
			const [appSide, userSide, quota] = await Promise.allSettled([
				gh<any>(ctx.creds.app, "/installation/repositories", { query: { per_page: 1 } }),
				gh<any>(ctx.creds.user, "/user"),
				checkQuota(ctx.env, ctx.tenant.installationId),
			]);

			return {
				app:
					appSide.status === "fulfilled"
						? {
								slug: ctx.tenant.appSlug,
								bot_login: ctx.tenant.botLogin,
								installation_id: ctx.tenant.installationId,
								account: ctx.tenant.accountLogin,
								account_type: ctx.tenant.accountType,
								repositories_accessible: appSide.value.total_count,
							}
						: { error: scrub(String(appSide.reason?.message ?? appSide.reason)) },
				user:
					userSide.status === "fulfilled"
						? {
								login: userSide.value.login,
								id: userSide.value.id,
								name: userSide.value.name ?? undefined,
								type: userSide.value.type,
							}
						: { error: scrub(String(userSide.reason?.message ?? userSide.reason)) },
				default_write_identity: "app",
				usage:
					quota.status === "fulfilled"
						? {
								tool_calls_this_month: quota.value.used,
								monthly_limit: quota.value.limit,
								resets_at: quota.value.resetsAt,
							}
						: undefined,
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
			const raw = await gh<any[]>(ctx.creds.user, `${repoPath(a)}/issues`, {
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
		async (a) =>
			compactIssue(await gh<any>(ctx.creds.user, `${repoPath(a)}/issues/${a.issue_number}`)),
	);

	register(
		"search_issues",
		{
			annotations: { readOnlyHint: true },
			description:
				"Search issues and pull requests across GitHub using search syntax. Scope the " +
				"query with qualifiers such as `repo:owner/name`, `is:open`, `label:bug`, or " +
				"`author:login` — without them this searches all of GitHub. This runs as you " +
				"rather than as the app, so it can surface issues in repositories the write " +
				"tools cannot touch; use whoami to see where the app is actually installed. " +
				"Note this endpoint has its own rate limit of 30 requests per minute.",
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
			const found = await gh<any>(ctx.creds.user, "/search/issues", {
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
				...actAs,
			},
		},
		async (a) =>
			compactIssue(
				await gh<any>(ctx.creds.as(a.act_as), `${repoPath(a)}/issues`, {
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
				...actAs,
			},
		},
		async (a) =>
			compactIssue(
				await gh<any>(ctx.creds.as(a.act_as), `${repoPath(a)}/issues/${a.issue_number}`, {
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

	// ----------------------------------------------------------- pull requests

	/**
	 * Reads the issues a PR will close. Degrades to `undefined` rather than
	 * failing the whole tool: a PR's own details are still worth returning when
	 * the GraphQL half is unavailable, and the caller can tell "no links" (an
	 * empty array) from "could not check" (the key being absent).
	 */
	async function closingIssues(a: any): Promise<number[] | undefined> {
		try {
			const result = await ghGraphQL<any>(ctx.creds.user, CLOSING_ISSUES_QUERY, {
				owner: a.owner,
				repo: a.repo,
				number: a.pull_number,
			});
			const nodes = result.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
			return nodes.map((node: any) => node.number);
		} catch {
			return undefined;
		}
	}

	/**
	 * The warning that catches the silent failure. GitHub parses closing keywords
	 * only when the pull request targets the default branch; against any other
	 * base it creates no link at all while still returning a perfectly successful
	 * response. Without this, a tool result would report a link that isn't there.
	 *
	 * Costs one extra request, and only when linking was actually asked for.
	 */
	async function linkNotice(a: any, base: string | undefined): Promise<string | undefined> {
		if (!a.closes?.length || !base) {
			return undefined;
		}

		let defaultBranch: string | undefined;
		try {
			defaultBranch = (await gh<any>(ctx.creds.user, repoPath(a))).default_branch;
		} catch {
			// A failed check must never turn a write that already succeeded into
			// an error. Silence is the right failure mode here.
			return undefined;
		}

		if (!defaultBranch || base === defaultBranch) {
			return undefined;
		}

		return (
			`No issue link was created. GitHub interprets closing keywords only when a pull ` +
			`request targets the default branch (${defaultBranch}), and this one targets ` +
			`${base}. The keywords are in the body and will take effect if the base is ` +
			`changed to ${defaultBranch}; until then the issues are not linked and merging ` +
			`will not close them.`
		);
	}

	register(
		"list_pull_requests",
		{
			annotations: { readOnlyHint: true },
			description: "List pull requests in a repository.",
			inputSchema: {
				...repoShape,
				state: z.enum(["open", "closed", "all"]).default("open"),
				head: z
					.string()
					.optional()
					.describe("Filter by head branch, as 'owner:branch' for a fork"),
				base: z.string().optional().describe("Filter by the branch being merged into"),
				sort: z
					.enum(["created", "updated", "popularity", "long-running"])
					.default("created"),
				direction: z.enum(["asc", "desc"]).default("desc"),
				...paging,
			},
		},
		async (a) => {
			const raw = await gh<any[]>(ctx.creds.user, `${repoPath(a)}/pulls`, {
				query: {
					state: a.state,
					head: a.head,
					base: a.base,
					sort: a.sort,
					direction: a.direction,
					per_page: a.per_page,
					page: a.page,
				},
			});
			return {
				count: raw.length,
				page: a.page,
				pull_requests: raw.map(compactPullRequest),
			};
		},
	);

	register(
		"get_pull_request",
		{
			annotations: { readOnlyHint: true },
			description:
				"Fetch a single pull request, including its body and the issues it will close. " +
				"`closes_issues` is omitted entirely if the link could not be read, which is " +
				"different from it being present and empty.",
			inputSchema: {
				...repoShape,
				pull_number: z.number().int().positive(),
			},
		},
		async (a) => {
			const [pr, closes] = await Promise.all([
				gh<any>(ctx.creds.user, `${repoPath(a)}/pulls/${a.pull_number}`),
				closingIssues(a),
			]);
			return { ...compactPullRequest(pr), closes_issues: closes };
		},
	);

	register(
		"create_pull_request",
		{
			annotations: { destructiveHint: false },
			description:
				"Open a pull request for a branch that has already been pushed to GitHub. This " +
				"server cannot push code — commit and push with git first, then call this. Use " +
				"`closes` to link the pull request to the issues it resolves.",
			inputSchema: {
				...repoShape,
				title: z.string().min(1),
				head: z
					.string()
					.min(1)
					.describe(
						"The branch holding the changes. It must already exist on GitHub. Use " +
							"'owner:branch' when the branch is on a fork.",
					),
				base: z.string().min(1).describe("The branch to merge into, e.g. 'main'"),
				body: z.string().optional().describe("PR body in GitHub-flavoured Markdown"),
				closes: z
					.array(z.number().int().positive())
					.optional()
					.describe(
						"Issue numbers this pull request resolves. Rendered into the body as " +
							"GitHub closing keywords, which is the only mechanism that creates the " +
							"link — GitHub has no API for it. The link is created ONLY when `base` " +
							"is the repository's default branch; against any other base the " +
							"keywords are ignored and the result will say so.",
					),
				draft: z.boolean().default(false),
				maintainer_can_modify: z
					.boolean()
					.optional()
					.describe("Whether maintainers can push to the head branch"),
				...actAs,
			},
		},
		async (a) => {
			const pr = await gh<any>(ctx.creds.as(a.act_as), `${repoPath(a)}/pulls`, {
				method: "POST",
				body: {
					title: a.title,
					head: a.head,
					base: a.base,
					body: withClosingKeywords(a.body, a.closes),
					draft: a.draft,
					maintainer_can_modify: a.maintainer_can_modify,
				},
			});

			return {
				...compactPullRequest(pr),
				link_warning: await linkNotice(a, a.base),
			};
		},
	);

	register(
		"update_pull_request",
		{
			annotations: { destructiveHint: true },
			description:
				"Update an existing pull request, and the way to link issues to one that is " +
				"already open. `closes` appends closing keywords to the body and is safe to " +
				"repeat — an issue already linked is not added twice. Take care: `body` REPLACES " +
				"the existing body. This is also how a pull request is closed, via `state`.",
			inputSchema: {
				...repoShape,
				pull_number: z.number().int().positive(),
				title: z.string().min(1).optional(),
				body: z.string().optional().describe("REPLACES the existing body"),
				state: z.enum(["open", "closed"]).optional(),
				base: z.string().optional().describe("Retarget the pull request at another branch"),
				closes: z
					.array(z.number().int().positive())
					.optional()
					.describe(
						"Issue numbers to link, appended to the body as closing keywords. Only " +
							"takes effect when the pull request targets the default branch.",
					),
				...actAs,
			},
		},
		async (a) => {
			let body = a.body;
			let base = a.base;

			// Linking is read-modify-write on the body, so anything the caller did
			// not supply has to be read back before it can be appended to.
			if (a.closes?.length && (body === undefined || base === undefined)) {
				const current = await gh<any>(
					ctx.creds.user,
					`${repoPath(a)}/pulls/${a.pull_number}`,
				);
				body = body ?? current.body ?? "";
				base = base ?? current.base?.ref;
			}

			const pr = await gh<any>(
				ctx.creds.as(a.act_as),
				`${repoPath(a)}/pulls/${a.pull_number}`,
				{
					method: "PATCH",
					body: {
						title: a.title,
						body: withClosingKeywords(body, a.closes),
						state: a.state,
						// Only ever the explicit value — `base` above may have been
						// read back purely to decide whether to warn.
						base: a.base,
					},
				},
			);

			return {
				...compactPullRequest(pr),
				link_warning: await linkNotice(a, base),
			};
		},
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
			const raw = await gh<any[]>(
				ctx.creds.user,
				`${repoPath(a)}/issues/${a.issue_number}/comments`,
				{ query: { since: a.since, per_page: a.per_page, page: a.page } },
			);
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
				...actAs,
			},
		},
		async (a) =>
			compactComment(
				await gh<any>(
					ctx.creds.as(a.act_as),
					`${repoPath(a)}/issues/${a.issue_number}/comments`,
					{ method: "POST", body: { body: a.body } },
				),
			),
	);

	register(
		"update_issue_comment",
		{
			annotations: { destructiveHint: true },
			description:
				"Edit an existing comment. Takes the comment's own id — from list_issue_comments " +
				"— not the issue number. You can only edit a comment the same identity wrote, so " +
				"act_as must match whoever authored it.",
			inputSchema: {
				...repoShape,
				comment_id: z.number().int().positive(),
				body: z.string().min(1),
				...actAs,
			},
		},
		async (a) =>
			compactComment(
				await gh<any>(
					ctx.creds.as(a.act_as),
					`${repoPath(a)}/issues/comments/${a.comment_id}`,
					{ method: "PATCH", body: { body: a.body } },
				),
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
			const raw = await gh<any[]>(ctx.creds.user, `${repoPath(a)}/labels`, {
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
				...actAs,
			},
		},
		async (a) => {
			const raw = await gh<any[]>(
				ctx.creds.as(a.act_as),
				`${repoPath(a)}/issues/${a.issue_number}/labels`,
				{ method: "POST", body: { labels: a.labels } },
			);
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
				...actAs,
			},
		},
		async (a) => {
			const raw = await gh<any[]>(
				ctx.creds.as(a.act_as),
				`${repoPath(a)}/issues/${a.issue_number}/labels/${seg(a.label)}`,
				{ method: "DELETE" },
			);
			return { labels: (raw ?? []).map(compactLabel) };
		},
	);

	// ---------------------------------------------------------------- security

	registerSecurityTools(register, ctx);

	return server;
}
