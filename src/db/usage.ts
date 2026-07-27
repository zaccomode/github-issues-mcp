/**
 * Metering. Two exports only, so that swapping D1 for a Durable Object later is
 * a one-file change.
 *
 * D1 serialises writes per database, so a very hot tenant will eventually
 * contend. The upgrade path is a Tenant Durable Object keyed by installation id,
 * holding the counter in strongly-consistent storage and flushing to D1 on an
 * alarm. Not worth building until the contention is real.
 */

import { type AppEnv, defaultMonthlyQuota } from "../env";

export type UsageKind = "tool_call" | "github_request";

export interface QuotaVerdict {
	allowed: boolean;
	used: number;
	/** Null means unlimited. */
	limit: number | null;
	resetsAt: string;
}

/** The billing period a timestamp falls in. */
function period(at = new Date()): string {
	return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextPeriodStart(at = new Date()): string {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Atomic increment. Never read-modify-write a counter across requests — two
 * concurrent tool calls would each read the same value and one increment would
 * vanish.
 *
 * Always called through `waitUntil`: metering must not add latency, and must
 * never be the reason a tool call fails.
 */
export async function recordUsage(
	env: AppEnv,
	installationId: number,
	kind: UsageKind,
	amount = 1,
): Promise<void> {
	try {
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`INSERT INTO usage_counters (installation_id, period, kind, count, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(installation_id, period, kind)
			 DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at`,
		)
			.bind(installationId, period(), kind, amount, now)
			.run();
	} catch (error) {
		console.error("usage: failed to record", kind, error);
	}
}

/**
 * Checked once per HTTP request, before any handler runs, so an over-quota
 * tenant is refused without a GitHub round trip ever happening.
 */
export async function checkQuota(env: AppEnv, installationId: number): Promise<QuotaVerdict> {
	const resetsAt = nextPeriodStart();

	try {
		const [quota, counter] = await Promise.all([
			env.DB.prepare(`SELECT monthly_limit FROM quotas WHERE installation_id = ?1`)
				.bind(installationId)
				.first<{ monthly_limit: number | null }>(),
			env.DB.prepare(
				`SELECT count FROM usage_counters
				 WHERE installation_id = ?1 AND period = ?2 AND kind = 'tool_call'`,
			)
				.bind(installationId, period())
				.first<{ count: number }>(),
		]);

		// No row at all means the default plan; a row with a NULL limit is an
		// explicit grant of unlimited use.
		const limit = quota ? quota.monthly_limit : defaultMonthlyQuota(env);
		const used = counter?.count ?? 0;

		return { allowed: limit === null || used < limit, used, limit, resetsAt };
	} catch (error) {
		// Metering must never be the thing that takes the service down.
		console.error("usage: quota check failed, allowing", error);
		return { allowed: true, used: 0, limit: null, resetsAt };
	}
}
