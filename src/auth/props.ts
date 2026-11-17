/**
 * What we stash in the OAuth grant.
 *
 * `props` is encrypted by @cloudflare/workers-oauth-provider using the issued
 * MCP token as key material, so the GitHub tokens here cannot be recovered from
 * KV without a live token. `userId` and `metadata`, set alongside it in
 * src/auth/handler.ts, are *not* encrypted — identifiers only, never a secret.
 */

import type { AppEnv } from "../env";
import type { UserTokenSet } from "./user-oauth";

export interface GrantProps {
	/** GitHub's numeric user id — stable across a rename, unlike the login. */
	userId: number;
	login: string;
	/**
	 * The tenant binding. Every app-authenticated request in this grant mints a
	 * token for exactly this installation, and no tool argument can change it.
	 */
	installationId: number;
	accountLogin: string;
	accountType: "User" | "Organization";
	user: UserTokenSet;
}

export function isGrantProps(value: unknown): value is GrantProps {
	const props = value as GrantProps | undefined;
	return (
		typeof props?.userId === "number" &&
		typeof props.login === "string" &&
		typeof props.installationId === "number" &&
		typeof props.user?.accessToken === "string"
	);
}

/**
 * Names the OAuth grant a request's token belongs to, so something made on the
 * grant's behalf (an upload link) can later check the grant still exists.
 * Identifiers only: neither part is a secret.
 */
export interface GrantRef {
	/** The provider's user id, e.g. `gh-123-inst-456`; not GitHub's numeric id. */
	userId: string;
	grantId: string;
}

/**
 * Reads the grant from the bearer token on a request the OAuth provider has
 * already authenticated. The provider issues tokens as `userId:grantId:secret`
 * (see the note in src/auth/handler.ts), so the first two parts name the grant.
 */
export function grantRefFromRequest(request: Request): GrantRef | undefined {
	const match = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
	const parts = match?.[1].split(":");
	if (parts?.length !== 3 || !parts[0] || !parts[1]) {
		return undefined;
	}
	return { userId: parts[0], grantId: parts[1] };
}

/**
 * Whether a grant still exists and has not expired. Revoking a grant deletes
 * it, and KV listings catch up within about a minute.
 */
export async function grantIsActive(
	helpers: Pick<AppEnv["OAUTH_PROVIDER"], "listUserGrants">,
	grant: GrantRef,
): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	let cursor: string | undefined;
	do {
		const page = await helpers.listUserGrants(grant.userId, { cursor });
		const found = page.items.find((item) => item.id === grant.grantId);
		if (found) {
			return found.expiresAt === undefined || found.expiresAt > now;
		}
		cursor = page.cursor;
	} while (cursor);
	return false;
}
