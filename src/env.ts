import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * The runtime environment, as the rest of the code wants to see it.
 *
 * Two things need fixing up over the generated `Env`. Secrets never appear in
 * wrangler.jsonc, so `wrangler types` cannot know about them; and plain vars are
 * generated as the *literal* value in the config file, so `GITHUB_APP_ID` would
 * otherwise be typed as the empty string.
 */
export interface AppEnv extends Omit<
	Env,
	| "GITHUB_APP_ID"
	| "GITHUB_APP_SLUG"
	| "GITHUB_CLIENT_ID"
	| "PUBLIC_URL"
	| "DEFAULT_MONTHLY_QUOTA"
> {
	GITHUB_APP_ID: string;
	GITHUB_APP_SLUG: string;
	GITHUB_CLIENT_ID: string;
	PUBLIC_URL: string;
	DEFAULT_MONTHLY_QUOTA: string;

	/** Secrets. `wrangler secret put <name>`; see README. */
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_WEBHOOK_SECRET?: string;

	/** Injected by @cloudflare/workers-oauth-provider at runtime. */
	OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * Fails loudly at the point of use rather than producing a confusing GitHub
 * error three calls later. Misconfiguration is by far the likeliest failure on
 * a fresh deploy, so it is worth naming the exact missing binding.
 */
export function required(env: AppEnv, name: keyof AppEnv): string {
	const value = env[name];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`${String(name)} is not configured. Set it in wrangler.jsonc (vars) or with ` +
				`\`wrangler secret put ${String(name)}\`, then redeploy.`,
		);
	}
	return value;
}

/** The externally reachable origin, without a trailing slash. */
export function publicUrl(env: AppEnv): string {
	return required(env, "PUBLIC_URL").replace(/\/+$/, "");
}

/** Where GitHub sends the browser back after the OAuth handshake. */
export function callbackUrl(env: AppEnv): string {
	return `${publicUrl(env)}/callback`;
}

/** The page that installs the App on an account the user chooses. */
export function installUrl(env: AppEnv, state: string): string {
	const slug = encodeURIComponent(required(env, "GITHUB_APP_SLUG"));
	return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
}

export function defaultMonthlyQuota(env: AppEnv): number {
	const parsed = Number(env.DEFAULT_MONTHLY_QUOTA);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
}
