/**
 * Tenant bookkeeping. Nothing here is a credential — see migrations/0001_init.sql.
 */

import type { AppEnv } from "../env";
import type { GitHubUser, UserInstallation } from "../auth/user-oauth";

export type InstallationStatus = "active" | "suspended" | "deleted";

export async function recordInstallation(
	env: AppEnv,
	installation: UserInstallation,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO installations
			(id, account_id, account_login, account_type, repository_selection,
			 status, created_at, updated_at, last_seen_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, ?6)
		 ON CONFLICT(id) DO UPDATE SET
			account_login        = excluded.account_login,
			account_type         = excluded.account_type,
			repository_selection = excluded.repository_selection,
			status               = 'active',
			updated_at           = excluded.updated_at,
			last_seen_at         = excluded.last_seen_at`,
	)
		.bind(
			installation.id,
			installation.accountId ?? 0,
			installation.accountLogin,
			installation.accountType,
			installation.repositorySelection,
			now,
		)
		.run();
}

export async function recordUser(env: AppEnv, user: GitHubUser): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO users (id, login, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?3)
		 ON CONFLICT(id) DO UPDATE SET login = excluded.login, updated_at = excluded.updated_at`,
	)
		.bind(user.id, user.login, now)
		.run();
}

export async function recordConnection(
	env: AppEnv,
	options: {
		userId: number;
		installationId: number;
		clientId: string;
		clientName?: string;
	},
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO connections
			(user_id, installation_id, client_id, client_name, first_seen_at, last_seen_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
		 ON CONFLICT(user_id, installation_id, client_id) DO UPDATE SET
			client_name  = excluded.client_name,
			last_seen_at = excluded.last_seen_at,
			revoked_at   = NULL`,
	)
		.bind(
			options.userId,
			options.installationId,
			options.clientId,
			options.clientName ?? null,
			now,
		)
		.run();
}

/**
 * Whether this installation is still usable, cached briefly so the check can sit
 * on the hot path. The cache is why a webhook-driven revocation takes effect
 * within a minute rather than instantly — an acceptable trade for not doing a D1
 * read on every single MCP request.
 */
export async function installationStatus(
	env: AppEnv,
	installationId: number,
): Promise<InstallationStatus> {
	const cacheKey = `inststatus:${installationId}`;
	const cached = await env.CACHE.get(cacheKey);
	if (cached) {
		return cached as InstallationStatus;
	}

	const row = await env.DB.prepare(`SELECT status FROM installations WHERE id = ?1`)
		.bind(installationId)
		.first<{ status: InstallationStatus }>();

	// An unknown installation is one we have never recorded, which is not the
	// same as a revoked one — let the GitHub call be the judge.
	const status = row?.status ?? "active";
	await env.CACHE.put(cacheKey, status, { expirationTtl: 60 });
	return status;
}

export async function setInstallationStatus(
	env: AppEnv,
	installationId: number,
	status: InstallationStatus,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(`UPDATE installations SET status = ?2, updated_at = ?3 WHERE id = ?1`)
		.bind(installationId, status, now)
		.run();

	// Drop the cached verdict and any cached token so a revocation bites now.
	await Promise.all([
		env.CACHE.delete(`inststatus:${installationId}`),
		env.CACHE.delete(`inst:${installationId}`),
	]);
}
