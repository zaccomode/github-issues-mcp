import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import worker from "../src/index";

/**
 * The OAuth provider's public surface. Existing grants are bound to the
 * resource 0.x advertised for /mcp, so 1.x must advertise exactly that.
 */
describe("the OAuth provider", () => {
	const origin = (env as unknown as AppEnv).PUBLIC_URL.replace(/\/+$/, "");

	async function get(path: string, init?: RequestInit) {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request(`${origin}${path}`, init),
			env as unknown as AppEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return response;
	}

	it("publishes <PUBLIC_URL>/mcp as the protected resource", async () => {
		const response = await get("/.well-known/oauth-protected-resource/mcp");
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as { resource: string };
		expect(metadata.resource).toBe(`${origin}/mcp`);
	});

	it("challenges an unauthenticated /mcp request with that metadata", async () => {
		const response = await get("/mcp", { method: "POST" });
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(
			`${origin}/.well-known/oauth-protected-resource/mcp`,
		);
	});

	it("rejects a token it did not issue", async () => {
		const response = await get("/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer gh-1-inst-2:grant:secret" },
		});
		expect(response.status).toBe(401);
	});
});
