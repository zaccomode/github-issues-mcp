import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { authorizeHandler } from "./auth/handler";
import { type GrantProps, grantRefFromRequest, isGrantProps } from "./auth/props";
import { ReauthorizationRequired, refreshUserToken } from "./auth/user-oauth";
import { installationStatus } from "./db/tenants";
import { checkQuota } from "./db/usage";
import { type AppEnv, publicUrl } from "./env";
import { createCredentials } from "./github/credentials";
import { problem } from "./http";
import { createGitHubIssuesServer } from "./tools";

const MCP_ROUTE = "/mcp";

/**
 * Deliberately far shorter than the eight hours GitHub gives a user token. The
 * MCP token always expires first, which forces every refresh through
 * `tokenExchangeCallback` — the one place that can actually persist the new
 * GitHub token pair. See the note on `TokenSource.renew` in github/client.ts for
 * why refreshing anywhere else would brick the grant.
 */
const ACCESS_TOKEN_TTL = 60 * 60;

/** Under GitHub's ~6 month refresh window, so ours never outlives theirs. */
const REFRESH_TOKEN_TTL = 150 * 24 * 60 * 60;

/** Refresh a little early rather than racing the expiry boundary. */
const REFRESH_SKEW_SECONDS = 30 * 60;

/**
 * Runs only for requests the OAuth provider has already authenticated, so the
 * bearer token here is one we issued — the GitHub tokens arrive out of band in
 * `ctx.props` and never travel with the request.
 */
const mcpApiHandler = {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		const props = ctx.props;

		if (!isGrantProps(props)) {
			return problem(
				401,
				"This grant carries no GitHub credentials. Reconnect to authorise again.",
			);
		}

		// Checked on every request rather than trusting the check made at connect
		// time, so uninstalling the app disables grants that were already issued.
		// 401 rather than 403, because MCP clients read that as "re-run OAuth".
		const status = await installationStatus(env, props.installationId);
		if (status !== "active") {
			return new Response(
				JSON.stringify({
					error:
						`The GitHub App installation for ${props.accountLogin} is ${status}. ` +
						`Reinstall the app and reconnect the connector.`,
				}),
				{
					status: 401,
					headers: {
						"Content-Type": "application/json",
						"WWW-Authenticate": 'Bearer error="invalid_token"',
					},
				},
			);
		}

		// Refused before any GitHub request happens, so an over-quota tenant costs
		// us nothing but a D1 read.
		const quota = await checkQuota(env, props.installationId);
		if (!quota.allowed) {
			return problem(
				429,
				`This connection has used its monthly allowance of ${quota.limit} tool calls. ` +
					`It resets at ${quota.resetsAt}.`,
			);
		}

		const botLogin = `${env.GITHUB_APP_SLUG}[bot]`;
		const server = createGitHubIssuesServer({
			env,
			creds: createCredentials(env, props, botLogin),
			tenant: {
				installationId: props.installationId,
				accountLogin: props.accountLogin,
				accountType: props.accountType,
				appSlug: env.GITHUB_APP_SLUG,
				botLogin,
				login: props.login,
				userId: props.userId,
				grant: grantRefFromRequest(request),
			},
			waitUntil: (promise) => ctx.waitUntil(promise),
		});

		return createMcpHandler(server, { route: MCP_ROUTE })(request, env, ctx);
	},
};

/**
 * The OAuth provider. Built on the first request rather than at module load,
 * because its protected resource (RFC 9728) comes from `PUBLIC_URL`. Bindings
 * are constant for an isolate's lifetime, so one instance serves every request.
 */
let provider: OAuthProvider<AppEnv> | undefined;

function getProvider(env: AppEnv): OAuthProvider<AppEnv> {
	provider ??= new OAuthProvider<AppEnv>({
		apiHandlers: { [MCP_ROUTE]: mcpApiHandler },
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register",
		defaultHandler: authorizeHandler as any,

		/**
		 * The audience every token is bound to. 0.x advertised the path a client
		 * connected to, `<PUBLIC_URL>/mcp`, and stored that in each grant, so this
		 * must stay exactly that for existing grants to keep working.
		 */
		resourceMetadata: { resource: `${publicUrl(env)}${MCP_ROUTE}` },

		/**
		 * The single place a GitHub user token is ever refreshed. Doing it here means
		 * the replacement pair is written back into the grant, which is exactly what
		 * an API request cannot do.
		 */
		async tokenExchangeCallback({ grantType, props, env }) {
			const current = props as GrantProps;

			if (grantType === "authorization_code") {
				return { accessTokenTTL: ACCESS_TOKEN_TTL, refreshTokenTTL: REFRESH_TOKEN_TTL };
			}

			const now = Math.floor(Date.now() / 1000);
			if (current.user.expiresAt - now > REFRESH_SKEW_SECONDS) {
				return { accessTokenTTL: ACCESS_TOKEN_TTL };
			}

			try {
				const renewed = await refreshUserToken(env, current.user.refreshToken);
				return {
					newProps: { ...current, user: renewed },
					accessTokenTTL: ACCESS_TOKEN_TTL,
				};
			} catch (error) {
				// A spent or revoked refresh token is terminal. Since 1.1, throwing
				// `invalid_grant` here also revokes the grant, and the client sends
				// the user back through consent.
				if (error instanceof ReauthorizationRequired) {
					throw new OAuthError("invalid_grant", { description: error.message });
				}
				throw error;
			}
		},
	});
	return provider;
}

export default {
	fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		return (getProvider(env) as any).fetch(request, env, ctx);
	},
};
