/**
 * The OAuth `state` parameter, and the handshake it carries.
 *
 * Two jobs. It is the CSRF defence on /callback — a callback without a state we
 * issued is rejected. And it carries the parsed `AuthRequest` across the trip to
 * GitHub through KV rather than through the query string, so the client_id and
 * redirect_uri that reach `completeAuthorization` are always the ones the OAuth
 * library validated, never whatever came back on the wire.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "../env";
import { randomToken } from "./crypto";
import type { GitHubUser, UserInstallation, UserTokenSet } from "./user-oauth";

const TTL_SECONDS = 600;

export interface PendingAuthorization {
	authRequest: AuthRequest;
	clientName?: string;
	/**
	 * Set only while bouncing through the installation picker, where the
	 * authorization code has already been spent and cannot be exchanged again.
	 *
	 * This does put a user token in KV for up to ten minutes. It is the one place
	 * that happens; everywhere else the tokens live encrypted in grant props. The
	 * alternative — re-running the whole GitHub handshake after the user picks —
	 * costs a second round trip and gains little, since an attacker who can read
	 * this namespace can read the pending grant anyway.
	 */
	tokens?: UserTokenSet;
	user?: GitHubUser;
	/** Verified against `GET /user/installations`; the picker chooses from these. */
	installations?: UserInstallation[];
}

export async function issueState(env: AppEnv, pending: PendingAuthorization): Promise<string> {
	const state = randomToken();
	await env.CACHE.put(key(state), JSON.stringify(pending), { expirationTtl: TTL_SECONDS });
	return state;
}

/**
 * Reads a state and immediately deletes it, so a captured callback URL cannot be
 * replayed. KV has no atomic compare-and-delete, so there is a millisecond-scale
 * window in which two concurrent reads could both succeed; closing it entirely
 * would mean moving this into a Durable Object, which is not worth it for a
 * one-shot browser redirect.
 */
export async function consumeState(
	env: AppEnv,
	state: string | null,
): Promise<PendingAuthorization | undefined> {
	if (!state) {
		return undefined;
	}

	const stored = await env.CACHE.get<PendingAuthorization>(key(state), "json");
	if (!stored) {
		return undefined;
	}

	await env.CACHE.delete(key(state));
	return stored;
}

function key(state: string): string {
	return `oauthstate:${state}`;
}
