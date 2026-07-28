/**
 * The two GitHub identities a request can act as, bound together.
 *
 * This is the seam that replaced threading a raw PAT through every tool handler.
 * A handler asks for `creds.user` or `creds.as(args.act_as)` and never sees a
 * token, an installation id, or the machinery behind either.
 */

import { installationTokenSource } from "../auth/installation";
import type { GrantProps } from "../auth/props";
import type { AppEnv } from "../env";
import type { Actor, TokenSource } from "./client";

export interface Credentials {
	readonly app: TokenSource;
	readonly user: TokenSource;
	as(actor: Actor): TokenSource;
}

export function createCredentials(
	env: AppEnv,
	props: GrantProps,
	appBotLogin: string,
): Credentials {
	// The installation id comes from the grant and nowhere else. This is the
	// structural half of tenant isolation: there is no code path by which a tool
	// argument could reach it.
	const app = installationTokenSource(
		env,
		props.installationId,
		`the GitHub App (${appBotLogin}) installed on ${props.accountLogin}`,
	);

	const user: TokenSource = {
		kind: "user",
		label: `your GitHub account (@${props.login})`,
		async token() {
			return props.user.accessToken;
		},
		// Deliberately never renewed here — see the note on TokenSource.renew in
		// ./client.ts. Refreshing costs the refresh token, and an API request has
		// nowhere to write the replacement back to.
		async renew() {
			return null;
		},
	};

	return {
		app,
		user,
		as(actor) {
			return actor === "app" ? app : user;
		},
	};
}
