import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import type { TokenSource } from "../src/github/client";
import { createGitHubIssuesServer } from "../src/tools";

/**
 * A smoke test of the MCP transport itself: `agents` serves /mcp through the
 * v2 MCP server SDK's stateless handler, and @modelcontextprotocol/server is
 * pinned to the version agents expects, so this proves the pair still speaks
 * the protocol and that tool schemas reach clients intact.
 */
describe("the MCP endpoint", () => {
	const source: TokenSource = {
		kind: "app",
		label: "a test identity",
		async token() {
			throw new Error("No GitHub calls in this test.");
		},
		async renew() {
			return null;
		},
	};

	async function call(body: unknown, sessionId?: string) {
		const server = createGitHubIssuesServer({
			env: env as unknown as AppEnv,
			creds: { app: source, user: source, as: () => source },
			tenant: {
				installationId: 1,
				accountLogin: "acme",
				accountType: "Organization",
				appSlug: "test-app",
				botLogin: "test-app[bot]",
				login: "octocat",
				userId: 1,
			},
			waitUntil: () => undefined,
		});
		const ctx = createExecutionContext();
		const response = await createMcpHandler(() => server, { route: "/mcp" })(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...(sessionId ? { "mcp-session-id": sessionId } : {}),
				},
				body: JSON.stringify(body),
			}),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return response;
	}

	async function json(response: Response) {
		const text = await response.text();
		// Answered either as JSON or as a one-event SSE stream.
		const data = text.startsWith("{") ? text : /^data: (.*)$/m.exec(text)?.[1];
		return JSON.parse(data ?? "null");
	}

	it("initializes and lists the tools", async () => {
		const init = await call({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "0" },
			},
		});
		expect(init.status).toBe(200);
		expect((await json(init)).result.serverInfo.name).toBe("github-issues");

		const session = init.headers.get("mcp-session-id") ?? undefined;
		const list = await call(
			{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
			session,
		);
		expect(list.status).toBe(200);
		const tools = (await json(list)).result.tools;
		const names = tools.map((tool: { name: string }) => tool.name);
		const getIssue = tools.find((tool: { name: string }) => tool.name === "get_issue");
		expect(getIssue.inputSchema).toMatchObject({
			type: "object",
			properties: { owner: { type: "string" }, issue_number: { type: "integer" } },
		});
		expect(getIssue.inputSchema.required).toEqual(
			expect.arrayContaining(["owner", "repo", "issue_number"]),
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"publish_release",
				"update_release",
				"create_release_asset_upload",
			]),
		);
	});

	it("validates tool arguments before running the handler", async () => {
		const response = await call({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "get_issue", arguments: { owner: "acme", repo: "app" } },
		});
		expect(response.status).toBe(200);
		const body = await json(response);
		// Rejected by the schema, so the handler (whose token() throws) never ran.
		const error = body.error?.message ?? body.result?.content?.[0]?.text ?? "";
		expect(body.error ?? body.result?.isError).toBeTruthy();
		expect(error).toMatch(/issue_number/);
		expect(error).not.toMatch(/No GitHub calls/);
	});
});
