/**
 * Shared pieces of the tool layer: the per-request context, the argument shapes
 * every tool reuses, cursor paging, the closing-keyword rendering that links
 * pull requests to issues, and the functions that turn a GitHub failure into
 * something a model can actually act on — including the security tools' own
 * three-way split between a missing permission, missing access, and a feature
 * that is switched off.
 */

import { z } from "zod";
import { GitHubError, ISSUE_422_HINT, seg } from "../github/client";
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

export interface ToolConfig {
	description: string;
	inputSchema: z.ZodRawShape;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

/** The server's tool registration helper, handed to modules that add tools. */
export type Register = (
	name: string,
	config: ToolConfig,
	handler: (args: any) => Promise<unknown>,
) => void;

export const repoShape = {
	owner: z.string().describe("Repository owner — a user or organisation login"),
	repo: z.string().describe("Repository name"),
};

export const paging = {
	per_page: z.number().int().min(1).max(100).default(30),
	page: z.number().int().min(1).default(1),
};

/**
 * Paging for endpoints that page by cursor rather than page number. Some
 * (Dependabot alerts, security advisories) accept only a cursor, and the rest
 * accept both, so every security list tool takes this shape for consistency.
 */
export const cursorPaging = {
	per_page: z.number().int().min(1).max(100).default(30),
	cursor: z
		.string()
		.optional()
		.describe(
			"Omit for the first page. To fetch the next one, pass `next_cursor` from the " +
				"previous result exactly as given. A result with no `next_cursor` is the last page.",
		),
};

/**
 * Reads the next page's position out of a `Link` header and returns it as an
 * opaque cursor. GitHub writes it as `after=…` on cursor-paged endpoints and
 * `page=…` on the rest, and an endpoint that supports both may use either, so
 * the cursor records which one it was rather than the caller having to know.
 */
export function nextCursor(link: string | null | undefined): string | undefined {
	if (!link) {
		return undefined;
	}

	for (const [, target, rel] of link.matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)) {
		if (!rel.split(/\s+/).includes("next")) {
			continue;
		}

		let url: URL;
		try {
			url = new URL(target);
		} catch {
			return undefined;
		}

		const after = url.searchParams.get("after");
		if (after) {
			return `after:${after}`;
		}
		const page = url.searchParams.get("page");
		if (page && /^\d+$/.test(page)) {
			return `page:${page}`;
		}
		return undefined;
	}

	return undefined;
}

/** Turns a cursor from `nextCursor()` back into the query parameter it came from. */
export function cursorQuery(cursor: string | undefined): { after?: string; page?: number } {
	if (!cursor) {
		return {};
	}

	const split = cursor.indexOf(":");
	const kind = cursor.slice(0, split);
	const value = cursor.slice(split + 1);

	if (split > 0 && kind === "after" && value) {
		return { after: value };
	}
	if (split > 0 && kind === "page" && /^\d+$/.test(value)) {
		return { page: Number(value) };
	}

	throw new Error(
		`Unrecognised cursor "${cursor}". Pass next_cursor exactly as a previous result ` +
			`returned it, or omit cursor to start from the first page.`,
	);
}

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

/** Which identity a tool call ran as, and whether the tool let the caller choose. */
export interface RanAs {
	actor: "app" | "user";
	/** True for the write tools, which take `act_as`; reads always run as the user. */
	switchable: boolean;
}

/**
 * Works out a call's identity from the tool's own schema. Reads have no
 * `act_as` and always run as the signed-in person, so a missing `act_as` means
 * "user" for them — reading it as the "app" default, as a write would, sends
 * the model after an App installation fix for what is really a user-side
 * failure, and suggests an `act_as` the tool does not accept.
 */
export function ranAs(schema: z.ZodRawShape, args: any): RanAs {
	if (!("act_as" in schema)) {
		return { actor: "user", switchable: false };
	}
	return { actor: args?.act_as === "user" ? "user" : "app", switchable: true };
}

/**
 * A token acting for a person through an App reaches only what that person can
 * see AND what an installation of the App covers, so a private repository
 * outside every installation answers 404 even to someone with full access.
 */
function userCannotSee(target: string, tenant: Tenant): string {
	return (
		`A request made for @${tenant.login} through the App reaches only repositories that ` +
		`@${tenant.login} can see and, for private ones, that the App has been granted access ` +
		`to. So either @${tenant.login} cannot see ${target}, or the App's installation does ` +
		`not include it — add it at https://github.com/settings/installations.`
	);
}

/**
 * Adds the context that turns a bare GitHub status into a next action.
 *
 * `gh()` cannot do this itself — it never sees the tool's arguments, so it
 * cannot know whether a 422 involved assignees or which identity the caller
 * asked for. That knowledge only exists here.
 */
export function explain(
	error: unknown,
	args: any,
	tenant: Tenant,
	tool: string,
	identity: RanAs,
): string {
	const base = error instanceof Error ? error.message : String(error);
	if (!(error instanceof GitHubError)) {
		return base;
	}

	const feature = securityFeatureOf(tool);
	if (feature) {
		return explainSecurity(error, base, feature, args, tenant);
	}

	const { actor, switchable } = identity;
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
			return `${base}\n\n${userCannotSee(target, tenant)}`;

		case 403:
			if (actor === "user" && /rate limit/i.test(base)) {
				return (
					`${base}\n\nThat was your personal limit, which is shared across every GitHub ` +
					`App acting on your behalf. ` +
					(switchable
						? `Retrying with act_as: "app" uses the installation's separate limit.`
						: `Read tools always run as you, so wait for the reset.`)
				);
			}
			// Not only the app: a token acting for a person through the App is
			// capped at the App's permissions too, so reads hit this as well.
			if (isPullRequest) {
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

// ------------------------------------------------------------ security tools

export interface SecurityFeature {
	/** As GitHub names the feature in its UI. */
	name: string;
	/** What it holds, phrased to sit mid-sentence. */
	items: string;
	/** As the App's settings page names the repository permission. */
	permission: string;
	/** What a repository admin does to turn the feature on. */
	enable: string;
}

export const SECURITY_FEATURES = {
	dependabot: {
		name: "Dependabot alerts",
		items: "Dependabot alerts",
		permission: "Dependabot alerts",
		enable:
			"A repository admin can turn on Dependabot alerts under Settings → Code security. " +
			"They are available on every plan.",
	},
	codeScanning: {
		name: "Code scanning",
		items: "code scanning alerts",
		permission: "Code scanning alerts",
		enable:
			"A repository admin can set it up (for example CodeQL's default setup) under " +
			"Settings → Code security. Results appear only after the first analysis " +
			"completes. On private repositories it needs GitHub Code Security.",
	},
	secretScanning: {
		name: "Secret scanning",
		items: "secret scanning alerts",
		permission: "Secret scanning alerts",
		enable:
			"A repository admin can turn it on under Settings → Code security. It is free on " +
			"public repositories; private repositories need GitHub Secret Protection.",
	},
	advisories: {
		name: "Repository security advisories",
		items: "draft and privately reported security advisories",
		permission: "Repository security advisories",
		enable:
			"Privately reported vulnerabilities only arrive if a repository admin turns on " +
			"private vulnerability reporting under Settings → Code security.",
	},
} satisfies Record<string, SecurityFeature>;

const SECURITY_TOOLS = new Map<string, SecurityFeature>(
	Object.entries({
		list_dependabot_alerts: SECURITY_FEATURES.dependabot,
		get_dependabot_alert: SECURITY_FEATURES.dependabot,
		list_code_scanning_alerts: SECURITY_FEATURES.codeScanning,
		get_code_scanning_alert: SECURITY_FEATURES.codeScanning,
		list_secret_scanning_alerts: SECURITY_FEATURES.secretScanning,
		get_secret_scanning_alert: SECURITY_FEATURES.secretScanning,
		list_security_advisories: SECURITY_FEATURES.advisories,
		get_security_advisory: SECURITY_FEATURES.advisories,
	}),
);

/** The security feature a tool reads, or undefined for every other tool. */
export function securityFeatureOf(tool: string): SecurityFeature | undefined {
	return SECURITY_TOOLS.get(tool);
}

/**
 * GitHub's own wording when a feature is off rather than access is missing. It
 * answers with 403 or 404 depending on the feature, so the status alone cannot
 * tell the two apart and a model would otherwise chase a permission problem
 * that isn't there.
 */
const FEATURE_OFF =
	/\b(disabled|not enabled|must be enabled|no analysis found|advanced security)\b/i;

/**
 * The security tools are all reads, so they run as the signed-in person, and a
 * person's token reaches only what the App's permissions AND that person's own
 * repository access both allow. That makes three different fixes possible for
 * the same status code, and this says which one applies.
 */
function explainSecurity(
	error: GitHubError,
	base: string,
	feature: SecurityFeature,
	args: any,
	tenant: Tenant,
): string {
	const target = args?.owner && args?.repo ? `${args.owner}/${args.repo}` : "that repository";

	if (error.status === 422) {
		return base.replace(
			ISSUE_422_HINT,
			"One of the filter values was not accepted — check it against the tool's options.",
		);
	}

	if (error.status !== 403 && error.status !== 404) {
		return base;
	}

	if (/rate limit/i.test(base)) {
		return base;
	}

	if (FEATURE_OFF.test(base)) {
		// The client's generic 403 wording blames permissions, so say plainly
		// that this is the other cause.
		return (
			`${base}\n\nThis is not a permission problem: ${feature.items} are not available ` +
			`because the feature is turned off for ${target}. ${feature.enable}`
		);
	}

	// Both statuses already say which identity the request ran as.
	const access =
		`@${tenant.login} needs elevated access to ${target}: GitHub shows ${feature.items} ` +
		`only to people with write access or above, and some only to admins or the ` +
		`security manager role.`;

	if (error.status === 404) {
		return (
			`${base}\n\nIf ${target} and the item do exist: ${userCannotSee(target, tenant)} ` +
			`${access}`
		);
	}

	return (
		`${base}\n\nTwo things must both be true. First, the App's "${feature.permission}" ` +
		`repository permission must be granted at read. Granting it in the App's settings ` +
		`is not enough on its own — the owner of the installation on ${tenant.accountLogin} ` +
		`must approve the update before its tokens carry it; check for a pending approval ` +
		`at https://github.com/settings/installations. Second, ${access}`
	);
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
