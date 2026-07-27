/**
 * The user-to-server half of the GitHub App: the OAuth web flow that produces a
 * token acting as the signed-in human.
 *
 * A GitHub App's user tokens carry no OAuth scopes — what they can reach is the
 * app's declared permissions intersected with the user's own access — so no
 * `scope` parameter is sent anywhere in this file.
 */

import { type AppEnv, callbackUrl, required } from "../env";
import { ghRaw } from "../github/client";

const GITHUB_OAUTH = "https://github.com";

export interface UserTokenSet {
	accessToken: string;
	/** Epoch seconds. GitHub issues these with an 8-hour life. */
	expiresAt: number;
	refreshToken: string;
	/** Epoch seconds. Roughly six months out. */
	refreshExpiresAt: number;
}

export interface GitHubUser {
	id: number;
	login: string;
	name?: string;
	type: string;
}

export interface UserInstallation {
	id: number;
	accountId: number;
	accountLogin: string;
	accountType: "User" | "Organization";
	repositorySelection: "all" | "selected";
}

/** Where we send the browser to begin the handshake. */
export function buildAuthorizeUrl(env: AppEnv, state: string): string {
	const url = new URL("/login/oauth/authorize", GITHUB_OAUTH);
	url.searchParams.set("client_id", required(env, "GITHUB_CLIENT_ID"));
	// Built from configuration, never from the inbound request's Host header —
	// that header is attacker-influenceable, and GitHub requires an exact match
	// against the registered callback anyway.
	url.searchParams.set("redirect_uri", callbackUrl(env));
	url.searchParams.set("state", state);
	return url.toString();
}

export async function exchangeCode(env: AppEnv, code: string): Promise<UserTokenSet> {
	return tokenRequest(env, {
		client_id: required(env, "GITHUB_CLIENT_ID"),
		client_secret: required(env, "GITHUB_CLIENT_SECRET"),
		code,
		redirect_uri: callbackUrl(env),
	});
}

/**
 * Exchanges a refresh token for a new pair. Using a refresh token invalidates
 * both halves of the previous pair, so the result must be persisted — see the
 * `tokenExchangeCallback` in src/index.ts, which is the only place this is
 * called from.
 */
export async function refreshUserToken(env: AppEnv, refreshToken: string): Promise<UserTokenSet> {
	return tokenRequest(env, {
		client_id: required(env, "GITHUB_CLIENT_ID"),
		client_secret: required(env, "GITHUB_CLIENT_SECRET"),
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
}

/** Thrown when GitHub says the refresh token is spent or revoked. */
export class ReauthorizationRequired extends Error {
	constructor(detail: string) {
		super(
			"Your GitHub sign-in has expired and could not be renewed. Disconnect and " +
				`reconnect the connector to continue. (${detail})`,
		);
		this.name = "ReauthorizationRequired";
	}
}

async function tokenRequest(env: AppEnv, params: Record<string, string>): Promise<UserTokenSet> {
	const response = await fetch(`${GITHUB_OAUTH}/login/oauth/access_token`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "github-issues-mcp",
		},
		body: new URLSearchParams(params).toString(),
	});

	const payload = (await response.json()) as any;

	// GitHub reports OAuth failures as HTTP 200 with an `error` key, so the
	// status alone tells you nothing.
	if (payload?.error) {
		const detail = payload.error_description ?? payload.error;
		if (payload.error === "bad_refresh_token" || payload.error === "bad_verification_code") {
			throw new ReauthorizationRequired(String(detail));
		}
		throw new Error(`GitHub refused the token request: ${detail}`);
	}

	if (!payload?.access_token) {
		throw new Error(`GitHub returned no access token (HTTP ${response.status}).`);
	}

	const now = Math.floor(Date.now() / 1000);
	return {
		accessToken: payload.access_token,
		expiresAt: now + Number(payload.expires_in ?? 28_800),
		refreshToken: payload.refresh_token ?? "",
		refreshExpiresAt: now + Number(payload.refresh_token_expires_in ?? 15_811_200),
	};
}

export async function fetchUser(token: string): Promise<GitHubUser> {
	const user = await ghRaw<any>(token, "/user");
	return {
		id: user.id,
		login: user.login,
		name: user.name ?? undefined,
		type: user.type,
	};
}

/**
 * The installations of *this app* that the given user can reach.
 *
 * This is the authority on which installation a grant may be bound to. GitHub
 * puts an `installation_id` on the post-install redirect, but anyone can forge
 * that query parameter, so it is only ever cross-checked against this list —
 * never trusted on its own.
 */
export async function listUserInstallations(token: string): Promise<UserInstallation[]> {
	const found: UserInstallation[] = [];

	for (let page = 1; page <= 10; page++) {
		const result = await ghRaw<any>(token, "/user/installations", {
			query: { per_page: 100, page },
		});
		const batch: any[] = result.installations ?? [];

		for (const installation of batch) {
			found.push({
				id: installation.id,
				accountId: installation.account?.id,
				accountLogin: installation.account?.login ?? "unknown",
				accountType:
					installation.account?.type === "Organization" ? "Organization" : "User",
				repositorySelection: installation.repository_selection ?? "selected",
			});
		}

		if (batch.length < 100) {
			break;
		}
	}

	return found;
}
