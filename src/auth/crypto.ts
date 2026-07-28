/**
 * Small crypto helpers shared by the App JWT signer and the webhook verifier.
 *
 * Deliberately absent: anything that encrypts a GitHub token for storage. The
 * user's access and refresh tokens live in the OAuth grant's `props`, which
 * @cloudflare/workers-oauth-provider encrypts using the issued MCP token as key
 * material — so they cannot be recovered from KV without a live token. Mirroring
 * them anywhere else would trade that property away for nothing.
 */

export function base64ToBytes(value: string): Uint8Array {
	// Accepts base64url too, since secrets get pasted from all sorts of places.
	const normalised = value.trim().replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(normalised);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A URL-safe random string, for OAuth `state` values. */
export function randomToken(bytes = 32): string {
	return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Constant-time string comparison, for webhook signatures. `===` on strings
 * leaks the position of the first differing byte through timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let difference = 0;
	for (let i = 0; i < a.length; i++) {
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return difference === 0;
}
