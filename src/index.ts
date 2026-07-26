import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { allowedLogins, authorizeHandler } from "./authorize";
import { createGitHubIssuesServer } from "./tools";

const MCP_ROUTE = "/mcp";

/** What we stashed in the grant at /authorize. Encrypted at rest by the provider. */
interface GrantProps {
	login: string;
	pat: string;
}

/**
 * Runs only for requests the OAuth provider has already authenticated, so the
 * bearer token here is one we issued — the GitHub PAT arrives out of band in
 * `ctx.props` and never travels with the request.
 */
const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = ctx.props as GrantProps | undefined;

		if (!props?.pat) {
			return problem(
				401,
				"This grant carries no GitHub token. Reconnect to authorise again.",
			);
		}

		// Re-checked on every request rather than trusting the check made at
		// authorize time, so removing a login from ALLOWED_LOGINS immediately
		// disables grants that were already issued to it.
		if (!allowedLogins(env).includes(props.login.toLowerCase())) {
			return problem(403, `GitHub user '${props.login}' is no longer authorised.`);
		}

		const server = createGitHubIssuesServer(props.pat, props.login);
		return createMcpHandler(server, { route: MCP_ROUTE })(request, env, ctx);
	},
};

function problem(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export default new OAuthProvider({
	apiHandlers: { [MCP_ROUTE]: mcpApiHandler },
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	defaultHandler: authorizeHandler,
});
