/**
 * Shared pieces of the tool layer: the per-request context, the argument shapes
 * every tool reuses, and the two functions that turn a GitHub failure into
 * something a model can actually act on.
 */

import { z } from "zod";
import { GitHubError, seg } from "../github/client";
import type { Credentials } from "../github/credentials";
import type { AppEnv } from "../env";

export interface Tenant {
	installationId: number;
	accountLogin: string;
	accountType: "User" | "Organization";
	appSlug: string;
	botLogin: string;
	/** The signed-in human. */
	login: string;
	userId: number;
}

export interface ToolContext {
	env: AppEnv;
	tenant: Tenant;
	creds: Credentials;
	waitUntil: (promise: Promise<unknown>) => void;
}

export const repoShape = {
	owner: z.string().describe("Repository owner — a user or organisation login"),
	repo: z.string().describe("Repository name"),
};

export const paging = {
	per_page: z.number().int().min(1).max(100).default(30),
	page: z.number().int().min(1).default(1),
};

/**
 * Who a write is attributed to. Defaulting to the app is the whole point of the
 * server: an agent's changes should be legible as an agent's changes.
 */
export const actAs = {
	act_as: z
		.enum(["app", "user"])
		.default("app")
		.describe(
			"Who this change is attributed to on GitHub. 'app' (the default) posts as the " +
				"app's bot account, so it is obvious an agent made the change, and uses the " +
				"installation's own rate limit. 'user' posts as the signed-in person, badged " +
				"as coming via the app — use it only when authorship genuinely needs to read " +
				"as a human. Note the bot cannot be an issue assignee under either setting.",
		),
};

/** Builds the `/repos/{owner}/{repo}` prefix with both segments escaped. */
export const repoPath = (a: { owner: string; repo: string }) =>
	`/repos/${seg(a.owner)}/${seg(a.repo)}`;

/**
 * Adds the context that turns a bare GitHub status into a next action.
 *
 * `gh()` cannot do this itself — it never sees the tool's arguments, so it
 * cannot know whether a 422 involved assignees or which identity the caller
 * asked for. That knowledge only exists here.
 */
export function explain(error: unknown, args: any, tenant: Tenant): string {
	const base = error instanceof Error ? error.message : String(error);
	if (!(error instanceof GitHubError)) {
		return base;
	}

	const actor: "app" | "user" = args?.act_as === "user" ? "user" : "app";
	const target = args?.owner && args?.repo ? `${args.owner}/${args.repo}` : "that repository";

	switch (error.status) {
		case 410:
			return base;

		case 422:
			if (actor === "app" && args?.assignees?.length) {
				return (
					`${base}\n\nThis ran as the app's bot account. Bot accounts cannot be issue ` +
					`assignees, so assigning the bot itself is not possible at all. Assigning a ` +
					`person works under either act_as — check the login is spelled correctly and ` +
					`is a collaborator on ${target}.`
				);
			}
			return base;

		case 404:
			if (actor === "app") {
				return (
					`${base}\n\nThe app is installed on ${tenant.accountLogin}. Because GitHub ` +
					`returns 404 rather than 403 for repositories an installation cannot see, ` +
					`this usually means the app was never granted access to ${target}. Add it at ` +
					`https://github.com/settings/installations, or retry with act_as: "user" if ` +
					`you personally have access.`
				);
			}
			return (
				`${base}\n\nThis ran as @${tenant.login}, so it means that account cannot see ` +
				`${target}.`
			);

		case 403:
			if (actor === "user" && /rate limit/i.test(base)) {
				return (
					`${base}\n\nThat was your personal limit, which is shared across every GitHub ` +
					`App acting on your behalf. Retrying with act_as: "app" uses the ` +
					`installation's separate limit.`
				);
			}
			return base;

		default:
			return base;
	}
}

/**
 * Belt and braces against a credential ever reaching a model. Nothing currently
 * puts a token into an error — `readErrorDetail` only surfaces GitHub's own
 * `message` — but this is the last point before text leaves the server, and it
 * costs nothing.
 */
export function scrub(text: string): string {
	return text.replace(
		/gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN[^-]*-----/g,
		"[redacted]",
	);
}
