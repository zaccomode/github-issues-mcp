/**
 * Shared pieces of the tool layer: the per-request context, the argument shapes
 * every tool reuses, the closing-keyword rendering that links pull requests to
 * issues, and the two functions that turn a GitHub failure into something a
 * model can actually act on.
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

// ------------------------------------------------------- issue links on a PR

/**
 * GitHub has no API for linking a pull request to an issue — not in REST, not
 * as a GraphQL mutation. The link exists only as a side effect of GitHub
 * parsing a closing keyword out of the PR *body*, and only when the PR targets
 * the repository's default branch.
 *
 * So the linking feature is really body authoring, and this is all of it. The
 * pattern matches every form GitHub accepts (close/closes/closed, fix/fixes/
 * fixed, resolve/resolves/resolved, any case, optional colon) so that we can
 * recognise a link the model wrote by hand and avoid duplicating it.
 */
const CLOSING_KEYWORD = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";

/** Whether `body` already closes `issue`, in any of the accepted spellings. */
export function linksIssue(body: string, issue: number): boolean {
	return new RegExp(`\\b${CLOSING_KEYWORD}\\b\\s*:?\\s+#${issue}\\b`, "i").test(body);
}

/**
 * Appends `Closes #n` for each issue not already linked. Returns `body`
 * unchanged when there is nothing to add, which keeps a repeated call a no-op
 * rather than a body that accretes a duplicate line every time.
 */
export function withClosingKeywords(
	body: string | undefined,
	closes: number[] | undefined,
): string | undefined {
	if (!closes?.length) {
		return body;
	}

	const existing = body ?? "";
	const missing = closes.filter((issue) => !linksIssue(existing, issue));
	if (missing.length === 0) {
		return body;
	}

	const added = missing.map((issue) => `Closes #${issue}`).join("\n");
	return existing.trim() ? `${existing.trimEnd()}\n\n${added}\n` : `${added}\n`;
}

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
	// Only the pull request tools take these, and they are what distinguish a
	// PR failure from an issue one — which matters because the two have
	// different likely causes at the same status code.
	const isPullRequest = args?.head !== undefined || args?.pull_number !== undefined;

	switch (error.status) {
		case 410:
			return base;

		case 422:
			if (args?.head) {
				return (
					`${base}\n\nCreating a pull request fails with 422 for three common ` +
					`reasons: the head branch \`${args.head}\` has not been pushed to GitHub ` +
					`yet (this server cannot push — commit and push with git first), there ` +
					`are no commits between \`${args.base}\` and \`${args.head}\`, or an open ` +
					`pull request for that branch already exists.`
				);
			}
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
			if (actor === "app" && isPullRequest) {
				return (
					`${base}\n\nPull request tools need the app's "Pull requests" permission at ` +
					`read & write. Granting it in the App's settings is not enough on its own — ` +
					`GitHub does not apply updated permissions retroactively, so the owner of ` +
					`the installation on ${tenant.accountLogin} must approve the update before ` +
					`its tokens carry it. Check for a pending approval at ` +
					`https://github.com/settings/installations.`
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
