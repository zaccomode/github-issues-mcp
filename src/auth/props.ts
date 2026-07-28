/**
 * What we stash in the OAuth grant.
 *
 * `props` is encrypted by @cloudflare/workers-oauth-provider using the issued
 * MCP token as key material, so the GitHub tokens here cannot be recovered from
 * KV without a live token. `userId` and `metadata`, set alongside it in
 * src/auth/handler.ts, are *not* encrypted — identifiers only, never a secret.
 */

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
