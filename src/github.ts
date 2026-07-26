/**
 * A thin GitHub REST client. Every call is authenticated with a PAT supplied
 * by the caller on this request — no token is ever read from `env` or held in
 * module scope.
 */

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "github-issues-mcp";

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

export async function gh<T>(pat: string, path: string, options: RequestOptions = {}): Promise<T> {
	const url = new URL(path, GITHUB_API);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url, {
		method: options.method ?? "GET",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${pat}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
			"X-GitHub-Api-Version": API_VERSION,
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});

	if (!response.ok) {
		throw await toGitHubError(response);
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

async function toGitHubError(response: Response): Promise<GitHubError> {
	const detail = await readErrorDetail(response);

	switch (response.status) {
		case 401:
			return new GitHubError(
				401,
				`GitHub rejected the token (401). It may be expired or revoked. ${detail}`,
			);

		case 403: {
			// GitHub uses 403 for both permission failures and rate limiting;
			// the remaining-quota header is what distinguishes them.
			if (response.headers.get("x-ratelimit-remaining") === "0") {
				const reset = response.headers.get("x-ratelimit-reset");
				const when = reset ? new Date(Number(reset) * 1000).toISOString() : "shortly";
				return new GitHubError(
					403,
					`GitHub rate limit exceeded. The limit resets at ${when}.`,
				);
			}
			return new GitHubError(
				403,
				`GitHub denied this request (403). The token likely lacks the required permission. ${detail}`,
			);
		}

		case 404:
			// Worth spelling out: GitHub returns 404 rather than 403 for private
			// resources you cannot see, so "not found" often means "no access".
			return new GitHubError(
				404,
				`Not found (404). Either it does not exist, or this token has no access to it — ` +
					`GitHub returns 404 instead of 403 for repositories it will not reveal. ${detail}`,
			);

		case 410:
			return new GitHubError(410, `Issues are disabled for this repository (410). ${detail}`);

		case 422:
			return new GitHubError(
				422,
				`GitHub rejected the request as invalid (422). This usually means a label, ` +
					`assignee, milestone, or issue type does not exist in the repository. ${detail}`,
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
