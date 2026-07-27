/**
 * GitHub's webhook, which is how a tenant going away becomes something we know
 * about rather than something we discover when a token mint fails.
 *
 * Only installation lifecycle events matter here; everything else is
 * acknowledged and ignored so GitHub does not retry it.
 */

import { setInstallationStatus } from "../db/tenants";
import type { AppEnv } from "../env";
import { timingSafeEqual } from "./crypto";

export async function handleWebhook(request: Request, env: AppEnv): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const secret = env.GITHUB_WEBHOOK_SECRET;
	if (!secret) {
		return new Response("Webhooks are not configured on this deployment.", { status: 501 });
	}

	// Read once, as text: the signature covers the exact bytes GitHub sent, so
	// re-serialising parsed JSON would not verify.
	const body = await request.text();
	const signature = request.headers.get("X-Hub-Signature-256") ?? "";

	if (!(await verifySignature(secret, body, signature))) {
		return new Response("Bad signature", { status: 401 });
	}

	const event = request.headers.get("X-GitHub-Event");
	const payload = JSON.parse(body) as any;
	const installationId = payload?.installation?.id;

	if (event === "installation" && typeof installationId === "number") {
		switch (payload.action) {
			case "deleted":
				await setInstallationStatus(env, installationId, "deleted");
				break;
			case "suspend":
				await setInstallationStatus(env, installationId, "suspended");
				break;
			case "unsuspend":
			case "created":
				await setInstallationStatus(env, installationId, "active");
				break;
		}
	}

	if (event === "installation_repositories" && typeof installationId === "number") {
		// The set of visible repositories changed. Nothing to record, but the
		// cached installation token may have been minted against the old set.
		await env.CACHE.delete(`inst:${installationId}`);
	}

	return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
}

async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
	if (!signature.startsWith("sha256=")) {
		return false;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	const expected = `sha256=${[...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;

	return timingSafeEqual(expected, signature);
}
