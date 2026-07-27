/**
 * Everything the browser touches: consent, the trip to GitHub, the callback,
 * and choosing which installation a connection is bound to.
 *
 * The OAuth provider hands us any request that isn't an API route. Requests that
 * reach /mcp have already been authenticated by the library and are handled in
 * src/index.ts instead.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { type AppEnv, installUrl, publicUrl } from "../env";
import { recordConnection, recordInstallation, recordUser } from "../db/tenants";
import { html } from "../http";
import {
	consentPage,
	errorPage,
	installPage,
	installedPage,
	landingPage,
	pickerPage,
} from "./consent";
import { type PendingAuthorization, consumeState, issueState } from "./state";
import {
	type GitHubUser,
	type UserInstallation,
	type UserTokenSet,
	buildAuthorizeUrl,
	exchangeCode,
	fetchUser,
	listUserInstallations,
} from "./user-oauth";
import { handleWebhook } from "./webhook";

export const authorizeHandler = {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const url = new URL(request.url);

		try {
			switch (url.pathname) {
				case "/":
					return html(landingPage(`${publicUrl(env)}/mcp`));

				case "/healthz":
					return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });

				case "/authorize":
					return await handleAuthorize(request, env, url);

				case "/callback":
					return await handleCallback(request, env, url);

				case "/select":
					return await handleSelect(request, env);

				case "/webhooks/github":
					return await handleWebhook(request, env);

				default:
					return new Response("Not found\n", { status: 404 });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return html(errorPage("Something went wrong", message), 500);
		}
	},
};

async function handleAuthorize(request: Request, env: AppEnv, url: URL): Promise<Response> {
	// Re-parsed on both GET and POST rather than round-tripped through a hidden
	// field, so the client_id and redirect_uri are always the library-validated
	// ones rather than whatever was posted back to us.
	let authRequest: AuthRequest;
	try {
		authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return html(errorPage("Invalid authorization request", detail), 400);
	}

	const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
	if (!client) {
		return html(
			errorPage("Unknown client", `No such OAuth client: ${authRequest.clientId}`),
			400,
		);
	}

	if (request.method === "GET") {
		// Preserving the query string means the POST re-parses to the same request.
		return html(consentPage(client, `/authorize${url.search}`));
	}

	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const state = await issueState(env, {
		authRequest,
		clientName: client.clientName,
	});

	return Response.redirect(buildAuthorizeUrl(env, state), 302);
}

async function handleCallback(request: Request, env: AppEnv, url: URL): Promise<Response> {
	const pending = await consumeState(env, url.searchParams.get("state"));

	if (!pending) {
		// Someone who installed the App directly from GitHub's own listing lands
		// here with no handshake in flight. That is not an error — there is just
		// nothing to complete, so tell them where the server is.
		if (url.searchParams.get("setup_action") === "install") {
			return html(installedPage(`${publicUrl(env)}/mcp`));
		}
		return html(
			errorPage(
				"That sign-in link expired",
				"Start again from your MCP client — links are single-use and last ten minutes.",
			),
			400,
		);
	}

	const code = url.searchParams.get("code");
	if (!code) {
		const denied =
			url.searchParams.get("error_description") ?? "No authorization code arrived.";
		return html(errorPage("GitHub did not complete sign-in", denied), 400);
	}

	const tokens = await exchangeCode(env, code);
	const user = await fetchUser(tokens.accessToken);
	const installations = await listUserInstallations(tokens.accessToken);

	if (installations.length === 0) {
		// The code is spent, but "Request user authorization during installation"
		// means GitHub sends a fresh one when they come back from installing.
		const nextState = await issueState(env, {
			authRequest: pending.authRequest,
			clientName: pending.clientName,
		});
		return html(installPage(installUrl(env, nextState)));
	}

	// GitHub puts installation_id on the post-install redirect, but anyone can
	// forge it. It is only ever used as a hint, and only when it names an
	// installation this user genuinely has.
	const hinted = Number(url.searchParams.get("installation_id"));
	const chosen =
		installations.find((candidate) => candidate.id === hinted) ??
		(installations.length === 1 ? installations[0] : undefined);

	if (!chosen) {
		const nextState = await issueState(env, {
			authRequest: pending.authRequest,
			clientName: pending.clientName,
			tokens,
			user,
			installations,
		});
		return html(pickerPage(installations, nextState, installUrl(env, nextState)));
	}

	return complete(env, pending, tokens, user, chosen);
}

async function handleSelect(request: Request, env: AppEnv): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const form = await request.formData();
	const pending = await consumeState(env, String(form.get("state") ?? ""));

	if (!pending?.tokens || !pending.user || !pending.installations) {
		return html(
			errorPage(
				"That selection expired",
				"Start again from your MCP client — links are single-use and last ten minutes.",
			),
			400,
		);
	}

	// The authority is the list we fetched from GitHub for this user, not the
	// value posted back. Without this check a crafted form could bind the grant
	// to somebody else's installation.
	const requested = Number(form.get("installation_id"));
	const chosen = pending.installations.find((candidate) => candidate.id === requested);

	if (!chosen) {
		return html(
			errorPage(
				"Unknown account",
				"That account is not one the app is installed on for your GitHub user.",
			),
			400,
		);
	}

	return complete(env, pending, pending.tokens, pending.user, chosen);
}

async function complete(
	env: AppEnv,
	pending: PendingAuthorization,
	tokens: UserTokenSet,
	user: GitHubUser,
	installation: UserInstallation,
): Promise<Response> {
	await Promise.all([recordInstallation(env, installation), recordUser(env, user)]);
	await recordConnection(env, {
		userId: user.id,
		installationId: installation.id,
		clientId: pending.authRequest.clientId,
		clientName: pending.clientName,
	});

	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: pending.authRequest,
		userId: `gh:${user.id}:inst:${installation.id}`,
		// Not encrypted by the library — deliberately identifiers only, so grants
		// stay auditable and revocable without exposing anything sensitive. Never
		// put a token here.
		metadata: {
			login: user.login,
			userId: user.id,
			installationId: installation.id,
			accountLogin: installation.accountLogin,
		},
		scope: pending.authRequest.scope,
		props: {
			userId: user.id,
			login: user.login,
			installationId: installation.id,
			accountLogin: installation.accountLogin,
			accountType: installation.accountType,
			user: tokens,
		},
	});

	return Response.redirect(redirectTo, 302);
}
