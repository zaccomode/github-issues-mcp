/**
 * A thin GitHub REST client. Every call is authenticated by a token *source*
 * supplied by the caller on this request — no token is ever read from `env` or
 * held in module scope.
 *
 * The source indirection is what lets a single tool call choose whether it acts
 * as the GitHub App or as the signed-in human, and lets an expired installation
 * token be re-minted transparently.
 */

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "github-issues-mcp";

/** Which GitHub identity a request runs as. */
export type Actor = "app" | "user";

export interface TokenSource {
	readonly kind: Actor;
	/** Phrased for an error message, e.g. "the GitHub App (acme-issues[bot])". */
	readonly label: string;
	token(): Promise<string>;
	/**
	 * Discards any cached token and obtains a fresh one, or returns null if this
	 * identity cannot be renewed without human involvement.
	 *
	 * Installation tokens are freely re-mintable, so the app source implements
	 * this. User tokens deliberately do not: refreshing one invalidates the pair
	 * held in the grant's `props`, and an API request has no way to write `props`
	 * back — doing it here would spend the refresh token and then throw the
	 * replacement away, bricking the grant. User refresh happens only in
	 * `tokenExchangeCallback`; see src/index.ts.
	 */
	renew(): Promise<string | null>;
}

/** An error carrying a message already phrased for a model to act on. */
export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
	method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	query?: Record<string, QueryValue>;
	body?: unknown;
}

/**
 * Issues a request as `source`, retrying once if the token turns out to be
 * stale. Installation tokens are cached in KV, which is eventually consistent,
 * so a 401 on a cached token is expected rather than exceptional.
 */
export async function gh<T>(
	source: TokenSource,
	path: string,
	options: RequestOptions = {},
): Promise<T> {
	const response = await send(await source.token(), path, options);

	if (response.status === 401) {
		const renewed = await source.renew();
		if (renewed) {
			const retry = await send(renewed, path, options);
			return finish<T>(retry, source);
		}
	}

	return finish<T>(response, source);
}

/**
 * Issues a GraphQL query as `source`.
 *
 * GraphQL is needed for the handful of things REST does not expose — currently
 * only a pull request's linked issues. Note the failure mode differs from REST:
 * GitHub answers a rejected query with **HTTP 200 and an `errors` array**, so
 * `finish()` sees a success and returns normally. The same trap as GitHub's
 * OAuth token endpoint; see the note in src/auth/user-oauth.ts.
 */
export async function ghGraphQL<T>(
	source: TokenSource,
	query: string,
	variables: Record<string, unknown> = {},
): Promise<T> {
	const payload = await gh<{ data?: T; errors?: { message?: string }[] }>(source, "/graphql", {
		method: "POST",
		body: { query, variables },
	});

	if (payload?.errors?.length) {
		const detail = payload.errors.map((e) => e.message ?? "unknown error").join(" — ");
		throw new GitHubError(200, `GitHub rejected the GraphQL query. ${detail}`);
	}

	if (!payload?.data) {
		throw new GitHubError(200, "GitHub's GraphQL API returned no data.");
	}

	return payload.data;
}

/** A single unauthenticated-by-source request, for callers holding a raw token. */
export async function ghRaw<T>(
	token: string,
	path: string,
	options: RequestOptions = {},
): Promise<T> {
	return finish<T>(await send(token, path, options), undefined);
}

async function send(token: string, path: string, options: RequestOptions): Promise<Response> {
	const url = buildUrl(path, options.query);

	return fetch(url, {
		method: options.method ?? "GET",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
			"X-GitHub-Api-Version": API_VERSION,
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
}

/**
 * Paths are assembled from model-supplied strings (owner, repo, label), so the
 * origin has to be asserted rather than assumed. `new URL("//evil.com/x", base)`
 * is protocol-relative and resolves to a *different host*, which would send the
 * bearer token there. Both the prefix check and the origin check are load
 * bearing; `seg()` alone is not enough, because it is easy to forget one.
 */
function buildUrl(path: string, query?: Record<string, QueryValue>): URL {
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw new Error(`Refusing to request a non-absolute GitHub path: ${path}`);
	}

	const url = new URL(path, GITHUB_API);
	if (url.origin !== GITHUB_API) {
		throw new Error(`Refusing to send a GitHub token to ${url.origin}.`);
	}

	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}
	return url;
}

async function finish<T>(response: Response, source: TokenSource | undefined): Promise<T> {
	if (!response.ok) {
		throw await toGitHubError(response, source);
	}

	// 204 No Content — DELETE endpoints such as label removal can return this.
	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
}

/** Path segments come from tool arguments, so they must always be escaped. */
export function seg(value: string): string {
	return encodeURIComponent(value);
}

async function toGitHubError(
	response: Response,
	source: TokenSource | undefined,
): Promise<GitHubError> {
	const detail = await readErrorDetail(response);
	const ran = source ? ` This request ran as ${source.label}.` : "";

	switch (response.status) {
		case 401:
			return new GitHubError(
				401,
				`GitHub rejected the token (401). It may be expired or revoked.${ran} ${detail}`,
			);

		case 403: {
			// GitHub uses 403 for both permission failures and rate limiting;
			// the remaining-quota header is what distinguishes them.
			if (response.headers.get("x-ratelimit-remaining") === "0") {
				const reset = response.headers.get("x-ratelimit-reset");
				const when = reset ? new Date(Number(reset) * 1000).toISOString() : "shortly";
				return new GitHubError(
					403,
					`GitHub rate limit exceeded. The limit resets at ${when}.${ran}`,
				);
			}
			return new GitHubError(
				403,
				`GitHub denied this request (403). The token likely lacks the required ` +
					`permission.${ran} ${detail}`,
			);
		}

		case 404:
			// Worth spelling out: GitHub returns 404 rather than 403 for private
			// resources you cannot see, so "not found" often means "no access".
			return new GitHubError(
				404,
				`Not found (404). Either it does not exist, or this token has no access to it — ` +
					`GitHub returns 404 instead of 403 for repositories it will not reveal.${ran} ` +
					`${detail}`,
			);

		case 410:
			return new GitHubError(410, `Issues are disabled for this repository (410). ${detail}`);

		case 422:
			return new GitHubError(
				422,
				`GitHub rejected the request as invalid (422). This usually means a label, ` +
					`assignee, milestone, or issue type does not exist in the repository.${ran} ` +
					`${detail}`,
			);

		default:
			return new GitHubError(
				response.status,
				`GitHub returned ${response.status}. ${detail}`,
			);
	}
}

async function readErrorDetail(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as any;
		const parts: string[] = [];
		if (body?.message) parts.push(String(body.message));
		for (const err of body?.errors ?? []) {
			parts.push(err.message ?? `${err.field ?? "field"}: ${err.code ?? "invalid"}`);
		}
		return parts.join(" — ");
	} catch {
		return "";
	}
}
