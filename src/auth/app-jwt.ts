/**
 * Signs the short-lived JWT that authenticates us *as the GitHub App itself*
 * (as opposed to as an installation, or as a user). Its only use is minting
 * installation access tokens.
 *
 * Workers expose the standard WebCrypto API, so this needs no dependency —
 * RS256 is `RSASSA-PKCS1-v1_5` over SHA-256.
 */

import { type AppEnv, required } from "../env";
import { base64ToBytes, bytesToBase64Url } from "./crypto";

/** GitHub caps the lifetime at 10 minutes. Nine leaves room for clock drift. */
const LIFETIME_SECONDS = 540;

/** Re-sign a minute before the memoised JWT actually expires. */
const REFRESH_MARGIN_SECONDS = 60;

interface Memo {
	key: Promise<CryptoKey>;
	jwt?: { token: string; expiresAt: number };
}

/**
 * Keyed by a digest of the PEM rather than held in a bare module-level `let`,
 * so that rotating the secret cannot leave a warm isolate serving a JWT signed
 * with the retired key.
 */
const memos = new Map<string, Memo>();

export async function appJwt(env: AppEnv): Promise<string> {
	const pem = required(env, "GITHUB_APP_PRIVATE_KEY");
	const appId = required(env, "GITHUB_APP_ID");

	const fingerprint = await digest(pem);
	let memo = memos.get(fingerprint);
	if (!memo) {
		memo = { key: importPrivateKey(pem) };
		memos.set(fingerprint, memo);
	}

	const now = Math.floor(Date.now() / 1000);
	if (memo.jwt && memo.jwt.expiresAt - now > REFRESH_MARGIN_SECONDS) {
		return memo.jwt.token;
	}

	const expiresAt = now + LIFETIME_SECONDS;
	const header = { alg: "RS256", typ: "JWT" };
	const claims = {
		// Backdated to absorb skew between us and GitHub; GitHub rejects a JWT
		// whose `iat` is in its future.
		iat: now - 60,
		exp: expiresAt,
		iss: appId,
	};

	const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		await memo.key,
		new TextEncoder().encode(signingInput),
	);

	const token = `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
	memo.jwt = { token, expiresAt };
	return token;
}

/**
 * GitHub hands you a PKCS#1 key (`BEGIN RSA PRIVATE KEY`), but WebCrypto only
 * imports PKCS#8 (`BEGIN PRIVATE KEY`) and fails with an opaque `DataError` if
 * given the wrong one. That mismatch is the single likeliest thing to go wrong
 * when setting this up, so the error carries the exact fix.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
		throw new Error(
			"GITHUB_APP_PRIVATE_KEY is in PKCS#1 format, which WebCrypto cannot import. " +
				"Convert it first:\n" +
				"  openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt " +
				"-in app.private-key.pem -out app.pkcs8.pem\n" +
				"then `wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem`.",
		);
	}

	const body = pem
		// A PEM pasted into .dev.vars or a secret prompt often arrives with literal
		// backslash-n rather than real newlines.
		.replace(/\\n/g, "\n")
		.replace(/-----BEGIN [^-]+-----/, "")
		.replace(/-----END [^-]+-----/, "")
		.replace(/\s+/g, "");

	if (!body) {
		throw new Error("GITHUB_APP_PRIVATE_KEY does not look like a PEM private key.");
	}

	return crypto.subtle.importKey(
		"pkcs8",
		base64ToBytes(body),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

function encodeSegment(value: unknown): string {
	return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function digest(value: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return bytesToBase64Url(new Uint8Array(hash));
}
