import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { gh } from "./github";

/**
 * The OAuth consent screen.
 *
 * Claude's connectors will only accept a token obtained through an OAuth
 * handshake — they will not send one you paste into a config field. So this
 * page stands in for an identity provider: you paste a GitHub PAT, we verify
 * it belongs to an allowed login, and the provider issues its own token for
 * the client to use from then on.
 *
 * The PAT is stored in the grant's `props`, which the OAuth provider encrypts
 * using the issued token as key material — it cannot be recovered from KV
 * without a valid token, and it never reaches the MCP client.
 */

/** The provider injects OAUTH_PROVIDER into env at runtime. */
export interface AuthEnv extends Env {
	OAUTH_PROVIDER: OAuthHelpers;
}

export function allowedLogins(env: Env): string[] {
	return (env.ALLOWED_LOGINS ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

export const authorizeHandler = {
	async fetch(request: Request, env: AuthEnv): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			return new Response("github-issues-mcp — MCP endpoint is at /mcp\n", {
				headers: { "Content-Type": "text/plain" },
			});
		}

		if (url.pathname !== "/authorize") {
			return new Response("Not found\n", { status: 404 });
		}

		// Re-parsed on both GET and POST rather than round-tripped through a
		// hidden field, so the client_id and redirect_uri are always the
		// library-validated ones rather than whatever was posted back to us.
		let authRequest: AuthRequest;
		try {
			authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		} catch (error) {
			return new Response(
				`Invalid authorization request: ${error instanceof Error ? error.message : String(error)}`,
				{ status: 400 },
			);
		}

		const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
		if (!client) {
			return new Response(`Unknown OAuth client: ${authRequest.clientId}`, {
				status: 400,
			});
		}

		if (request.method === "GET") {
			return page(consentForm(url, client));
		}

		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const form = await request.formData();
		const pat = String(form.get("pat") ?? "").trim();
		if (!pat) {
			return page(consentForm(url, client, "Enter a token to continue."), 400);
		}

		let login: string;
		try {
			login = (await gh<{ login: string }>(pat, "/user")).login;
		} catch {
			return page(
				consentForm(url, client, "GitHub rejected that token. Check it has not expired."),
				401,
			);
		}

		if (!allowedLogins(env).includes(login.toLowerCase())) {
			return page(
				consentForm(
					url,
					client,
					`The account '${login}' is not authorised to use this server.`,
				),
				403,
			);
		}

		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			request: authRequest,
			userId: login,
			// Not encrypted by the library — deliberately just the login, so grants
			// stay auditable and revocable without exposing anything sensitive.
			metadata: { login },
			scope: authRequest.scope,
			props: { login, pat },
		});

		return Response.redirect(redirectTo, 302);
	},
};

function page(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

function consentForm(url: URL, client: ClientInfo, error?: string): string {
	const clientName = escapeHtml(client.clientName || client.clientId);
	// Preserving the query string means the POST re-parses to the same request.
	const action = escapeHtml(`/authorize${url.search}`);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to GitHub Issues</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.5 system-ui, -apple-system, sans-serif;
    max-width: 30rem; margin: 0 auto; padding: 3rem 1.25rem;
  }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: color-mix(in srgb, currentColor 65%, transparent); margin: 0 0 1.25rem; }
  label { display: block; font-weight: 600; margin-bottom: .375rem; }
  input {
    width: 100%; box-sizing: border-box; padding: .625rem .75rem; font: inherit;
    font-family: ui-monospace, monospace;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: .375rem; background: transparent; color: inherit;
  }
  button {
    margin-top: 1rem; width: 100%; padding: .625rem; font: inherit; font-weight: 600;
    border: 0; border-radius: .375rem; cursor: pointer;
    /* Not currentColor: it would resolve against this rule's own color. */
    background: CanvasText; color: Canvas;
  }
  .error {
    padding: .625rem .75rem; border-radius: .375rem; margin-bottom: 1.25rem;
    background: color-mix(in srgb, crimson 15%, transparent); color: crimson;
  }
  .hint { font-size: .8125rem; margin: .5rem 0 0; }
</style>
</head>
<body>
  <h1>Connect to GitHub Issues</h1>
  <p><strong>${clientName}</strong> is requesting access. Paste a GitHub personal
  access token to authorise it.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="${action}">
    <label for="pat">GitHub personal access token</label>
    <input id="pat" name="pat" type="password" autocomplete="off" spellcheck="false"
           autofocus placeholder="github_pat_… or ghp_…">
    <p class="hint">Needs Issues (read and write) and Metadata (read-only) on the
    repositories you want reachable. It is stored encrypted and is never shared
    with the client.</p>
    <button type="submit">Authorise</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
