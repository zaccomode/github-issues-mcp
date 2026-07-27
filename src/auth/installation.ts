/**
 * Installation access tokens — the credential that makes a write show up as
 * `your-app[bot]` rather than as a person.
 *
 * These are minted by presenting the App JWT, last an hour, and are cached in
 * KV per installation. Caching is not optional at multi-tenant scale: the
 * app-JWT endpoints share one 5,000/hour budget across every tenant, so minting
 * per request would make that budget the global ceiling for the whole service.
 */

import { type AppEnv } from "../env";
import { GitHubError, ghRaw, type TokenSource } from "../github/client";
import { appJwt } from "./app-jwt";

/** Well under the hour GitHub grants, so a cached token is never near the edge. */
const CACHE_TTL_SECONDS = 3000;

/** Treat a token with less than this left as already gone. */
const FRESHNESS_MARGIN_SECONDS = 300;

export interface InstallationToken {
	token: string;
	expiresAt: number;
	permissions: Record<string, string>;
	repositorySelection: "all" | "selected";
}

export async function mintInstallationToken(
	env: AppEnv,
	installationId: number,
): Promise<InstallationToken> {
	let minted: any;
	try {
		minted = await ghRaw<any>(
			await appJwt(env),
			`/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
			{ method: "POST" },
		);
	} catch (error) {
		// A 404 here does not mean "wrong URL" — it means this installation no
		// longer exists, i.e. the app was uninstalled. That deserves its own
		// message, because reconnecting is the only thing that fixes it.
		if (error instanceof GitHubError && error.status === 404) {
			throw new GitHubError(
				410,
				"This connection's GitHub App installation no longer exists — it was " +
					"probably uninstalled. Reinstall the app and reconnect the connector.",
			);
		}
		throw error;
	}

	return {
		token: minted.token,
		expiresAt: Math.floor(new Date(minted.expires_at).getTime() / 1000),
		permissions: minted.permissions ?? {},
		repositorySelection: minted.repository_selection ?? "selected",
	};
}

/**
 * A token source bound to exactly one installation. The installation id comes
 * from the grant's props and nothing else — no tool argument may influence it,
 * which is what keeps one tenant from reaching another's repositories.
 */
export function installationTokenSource(
	env: AppEnv,
	installationId: number,
	label: string,
): TokenSource {
	const cacheKey = `inst:${installationId}`;
	// Memoised for the life of the request, so a tool making three calls reads once.
	let pending: Promise<string> | undefined;

	async function fromCache(): Promise<string | undefined> {
		const cached = await env.CACHE.get<{ token: string; expiresAt: number }>(cacheKey, "json");
		if (!cached) {
			return undefined;
		}
		const now = Math.floor(Date.now() / 1000);
		return cached.expiresAt - now > FRESHNESS_MARGIN_SECONDS ? cached.token : undefined;
	}

	async function mintAndCache(): Promise<string> {
		const minted = await mintInstallationToken(env, installationId);
		await env.CACHE.put(
			cacheKey,
			JSON.stringify({ token: minted.token, expiresAt: minted.expiresAt }),
			{ expirationTtl: CACHE_TTL_SECONDS },
		);
		return minted.token;
	}

	return {
		kind: "app",
		label,
		token() {
			pending ??= (async () => (await fromCache()) ?? (await mintAndCache()))();
			return pending;
		},
		// KV is eventually consistent, so a cached token can be stale even when it
		// looks fresh. Re-minting is cheap and always correct.
		renew() {
			pending = mintAndCache();
			return pending;
		},
	};
}
