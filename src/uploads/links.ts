/**
 * Upload links: short-lived, single-use URLs on this Worker that accept one
 * release asset and pass it on to GitHub.
 *
 * They exist because a file must not travel inside a tool call. Base64 adds a
 * third to the size, and the model would have to read and type out every byte
 * exactly. Instead `create_release_asset_upload` hands back a link, the agent
 * sends the file from its shell with curl, and src/uploads/handler.ts streams
 * it on to GitHub as whichever identity the link was made for.
 *
 * A link is a bearer secret, so only its hash is stored. For act_as "user" the
 * person's token has to survive until the upload arrives, and it is sealed
 * with a key derived from the link: the row alone cannot be turned into a
 * GitHub credential, which keeps the promise that D1 holds none.
 */

import type { AppEnv } from "../env";
import { bytesToBase64Url, base64ToBytes, randomToken } from "../auth/crypto";
import type { Actor } from "../github/client";

/** Long enough to run a build and send it; the clock stops when the upload starts. */
export const LINK_TTL_SECONDS = 15 * 60;

/** Expired rows are kept this long after expiry, then swept. */
const SWEEP_AFTER_SECONDS = 24 * 60 * 60;

export const UPLOAD_PATH_PREFIX = "/uploads/";

export interface NewUploadLink {
	installationId: number;
	accountLogin: string;
	actor: Actor;
	userLogin: string;
	/** Required when `actor` is "user": the token the upload will run as. */
	userToken?: string;
	owner: string;
	repo: string;
	releaseId: number;
	name: string;
	label?: string;
	contentType: string;
}

export interface ClaimedUploadLink {
	installationId: number;
	accountLogin: string;
	actor: Actor;
	userLogin: string;
	/** Unsealed; present only when `actor` is "user". */
	userToken?: string;
	owner: string;
	repo: string;
	releaseId: number;
	name: string;
	label?: string;
	contentType: string;
}

interface Row {
	installation_id: number;
	account_login: string;
	actor: Actor;
	user_login: string;
	sealed_token: string | null;
	owner: string;
	repo: string;
	release_id: number;
	name: string;
	label: string | null;
	content_type: string;
	expires_at: number;
	used_at: number | null;
}

/** Stores a new link and returns its secret, the last path segment of the URL. */
export async function createUploadLink(
	env: AppEnv,
	link: NewUploadLink,
): Promise<{ secret: string; expiresAt: number }> {
	if (link.actor === "user" && !link.userToken) {
		throw new Error("An upload link acting as the user needs the user's token.");
	}

	const secret = randomToken();
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = now + LINK_TTL_SECONDS;
	const sealed = link.actor === "user" ? await seal(secret, link.userToken!) : null;

	await env.DB.prepare(
		`INSERT INTO upload_links (id, installation_id, account_login, actor, user_login,
			sealed_token, owner, repo, release_id, name, label, content_type, created_at,
			expires_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
	)
		.bind(
			await linkId(secret),
			link.installationId,
			link.accountLogin,
			link.actor,
			link.userLogin,
			sealed,
			link.owner,
			link.repo,
			link.releaseId,
			link.name,
			link.label ?? null,
			link.contentType,
			now,
			expiresAt,
		)
		.run();

	return { secret, expiresAt };
}

export type ClaimResult =
	| { ok: true; link: ClaimedUploadLink }
	| { ok: false; reason: "unknown" | "used" | "expired" };

/**
 * Marks a link used and returns it, or says why it cannot be used. The update
 * is the claim: of two requests racing on one link, exactly one sees a row.
 */
export async function claimUploadLink(env: AppEnv, secret: string): Promise<ClaimResult> {
	const id = await linkId(secret);
	const now = Math.floor(Date.now() / 1000);

	const row = await env.DB.prepare(
		`UPDATE upload_links SET used_at = ?2
		 WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2
		 RETURNING *`,
	)
		.bind(id, now)
		.first<Row>();

	if (!row) {
		// Only to choose the error message; the claim above already failed.
		const existing = await env.DB.prepare(
			`SELECT used_at, expires_at FROM upload_links WHERE id = ?1`,
		)
			.bind(id)
			.first<Pick<Row, "used_at" | "expires_at">>();
		if (!existing) {
			return { ok: false, reason: "unknown" };
		}
		return { ok: false, reason: existing.used_at !== null ? "used" : "expired" };
	}

	return {
		ok: true,
		link: {
			installationId: row.installation_id,
			accountLogin: row.account_login,
			actor: row.actor,
			userLogin: row.user_login,
			userToken: row.sealed_token ? await unseal(secret, row.sealed_token) : undefined,
			owner: row.owner,
			repo: row.repo,
			releaseId: row.release_id,
			name: row.name,
			label: row.label ?? undefined,
			contentType: row.content_type,
		},
	};
}

/** Deletes links that expired a day or more ago. Run through `waitUntil`. */
export async function sweepUploadLinks(env: AppEnv): Promise<void> {
	try {
		const cutoff = Math.floor(Date.now() / 1000) - SWEEP_AFTER_SECONDS;
		await env.DB.prepare(`DELETE FROM upload_links WHERE expires_at < ?1`).bind(cutoff).run();
	} catch (error) {
		console.error("uploads: failed to sweep expired links", error);
	}
}

// ----------------------------------------------------------------- crypto

const encoder = new TextEncoder();

async function linkId(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * An AES-GCM key derived from the link's secret. The info string keeps it
 * distinct from the SHA-256 used as the row id, which is stored in the clear.
 */
async function sealingKey(secret: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(0),
			info: encoder.encode("github-issues-mcp upload link token seal"),
		},
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

async function seal(secret: string, plaintext: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await sealingKey(secret),
		encoder.encode(plaintext),
	);
	const out = new Uint8Array(iv.length + ciphertext.byteLength);
	out.set(iv);
	out.set(new Uint8Array(ciphertext), iv.length);
	return bytesToBase64Url(out);
}

async function unseal(secret: string, sealed: string): Promise<string> {
	const bytes = base64ToBytes(sealed);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes.slice(0, 12) },
		await sealingKey(secret),
		bytes.slice(12),
	);
	return new TextDecoder().decode(plaintext);
}
