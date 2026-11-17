import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import {
	LINK_TTL_SECONDS,
	type NewUploadLink,
	claimUploadLink,
	createUploadLink,
	sweepUploadLinks,
} from "../src/uploads/links";

const appEnv = env as unknown as AppEnv;

const link = (overrides: Partial<NewUploadLink> = {}): NewUploadLink => ({
	grant: { userId: "gh-1-inst-2", grantId: "grant-1" },
	installationId: 2,
	accountLogin: "acme",
	actor: "user",
	userLogin: "octocat",
	userToken: "ghu_secret_token",
	owner: "acme",
	repo: "widgets",
	releaseId: 42,
	name: "app.zip",
	contentType: "application/zip",
	...overrides,
});

async function rowFor(secret: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return env.DB.prepare(`SELECT * FROM upload_links WHERE id = ?1`)
		.bind(id)
		.first<Record<string, unknown>>();
}

describe("upload links", () => {
	beforeEach(async () => {
		vi.useRealTimers();
		await env.DB.prepare(`DELETE FROM upload_links`).run();
	});

	it("seals the user token, and unseals it once on claim", async () => {
		const { secret } = await createUploadLink(appEnv, link());

		const stored = await rowFor(secret);
		expect(stored?.sealed_token).toBeTypeOf("string");
		expect(String(stored?.sealed_token)).not.toContain("ghu_secret_token");
		expect(stored?.grant_user_id).toBe("gh-1-inst-2");
		expect(stored?.grant_id).toBe("grant-1");

		const claim = await claimUploadLink(appEnv, secret);
		expect(claim).toMatchObject({
			ok: true,
			link: {
				userToken: "ghu_secret_token",
				grant: { userId: "gh-1-inst-2", grantId: "grant-1" },
				owner: "acme",
				repo: "widgets",
				releaseId: 42,
				name: "app.zip",
			},
		});

		// Cleared as soon as it is claimed, not when the row is swept a day later.
		expect((await rowFor(secret))?.sealed_token).toBeNull();
		expect(await claimUploadLink(appEnv, secret)).toEqual({ ok: false, reason: "used" });
	});

	it("stores no token for a link acting as the app", async () => {
		const { secret } = await createUploadLink(
			appEnv,
			link({ actor: "app", userToken: undefined }),
		);
		expect((await rowFor(secret))?.sealed_token).toBeNull();
		const claim = await claimUploadLink(appEnv, secret);
		expect(claim.ok && claim.link.userToken).toBeUndefined();
	});

	it("cannot unseal without the Worker secret", async () => {
		const { secret } = await createUploadLink(appEnv, link());
		const rotated = { ...appEnv, GITHUB_CLIENT_SECRET: "a-different-secret" };

		expect(await claimUploadLink(rotated, secret)).toEqual({ ok: false, reason: "unreadable" });
		expect((await rowFor(secret))?.sealed_token).toBeNull();
	});

	it("refuses unknown and expired links", async () => {
		expect(await claimUploadLink(appEnv, "x".repeat(43))).toEqual({
			ok: false,
			reason: "unknown",
		});

		const { secret } = await createUploadLink(appEnv, link());
		vi.useFakeTimers({ now: Date.now() + (LINK_TTL_SECONDS + 1) * 1000 });
		expect(await claimUploadLink(appEnv, secret)).toEqual({ ok: false, reason: "expired" });
	});

	it("lets exactly one of two racing claims through", async () => {
		const { secret } = await createUploadLink(appEnv, link());
		const results = await Promise.all([
			claimUploadLink(appEnv, secret),
			claimUploadLink(appEnv, secret),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
	});

	it("sweeps the token from expired links, then the rows a day later", async () => {
		const { secret } = await createUploadLink(appEnv, link());

		vi.useFakeTimers({ now: Date.now() + (LINK_TTL_SECONDS + 1) * 1000 });
		await sweepUploadLinks(appEnv);
		const expired = await rowFor(secret);
		expect(expired).not.toBeNull();
		expect(expired?.sealed_token).toBeNull();

		vi.useFakeTimers({ now: Date.now() + 25 * 60 * 60 * 1000 });
		await sweepUploadLinks(appEnv);
		expect(await rowFor(secret)).toBeNull();
	});

	it("leaves the token on links still waiting for their upload", async () => {
		const { secret } = await createUploadLink(appEnv, link());
		await sweepUploadLinks(appEnv);
		expect((await rowFor(secret))?.sealed_token).toBeTypeOf("string");
	});
});
