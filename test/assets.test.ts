import { describe, expect, it } from "vitest";
import { INLINE_MAX_BYTES, INLINE_MAX_CHARS, decode } from "../src/tools/release-assets";
import { assetNameProblem, guessContentType, isContentType } from "../src/uploads/assets";

describe("isContentType", () => {
	it.each(["application/zip", "text/plain; charset=utf-8", "application/vnd.api+json"])(
		"accepts %s",
		(value) => expect(isContentType(value)).toBe(true),
	);

	it.each(["zip", "text/plain\r\nX-Injected: 1", "text/plain; charset", "", "a/b c"])(
		"refuses %j",
		(value) => expect(isContentType(value)).toBe(false),
	);
});

describe("assetNameProblem", () => {
	it.each(["app.zip", "app-linux-x64.tar.gz", "SHA256SUMS", "a".repeat(255)])(
		"accepts %s",
		(name) => expect(assetNameProblem(name)).toBeUndefined(),
	);

	it.each(["", "   ", "dir/app.zip", "dir\\app.zip", "bad\nname", ".", "..", "a".repeat(256)])(
		"refuses %j",
		(name) => expect(assetNameProblem(name)).toBeTypeOf("string"),
	);
});

describe("guessContentType", () => {
	it.each([
		["app.tar.gz", "application/gzip"],
		["app.tgz", "application/gzip"],
		["app.ZIP", "application/zip"],
		["app.tar.zst", "application/zstd"],
		["sbom.json", "application/json"],
		["SHA256SUMS", "text/plain"],
		["checksums.txt", "text/plain"],
		["app.sha256", "text/plain"],
		["app.exe", "application/octet-stream"],
	])("%s is %s", (name, type) => expect(guessContentType(name)).toBe(type));
});

describe("decode", () => {
	const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

	it("encodes utf8 as-is", () => {
		expect(text(decode("héllo", "utf8"))).toBe("héllo");
	});

	it.each([
		["padded", "aGk=", "hi"],
		["unpadded", "aGk", "hi"],
		["double padding", "aA==", "h"],
		["wrapped across lines", "aGVs\nbG8=", "hello"],
	])("decodes %s base64", (_, input, expected) => {
		expect(text(decode(input, "base64"))).toBe(expected);
	});

	it.each(["ab=", "a", "abcde", "a===", "ab$c", "=", "aGk=aGk="])(
		"refuses malformed base64 %j with the tool's own error",
		(input) => {
			expect(() => decode(input, "base64")).toThrow("`content` is not valid base64.");
		},
	);

	it("bounds the content length to what can decode to the inline limit", () => {
		expect(INLINE_MAX_CHARS).toBeGreaterThanOrEqual(Math.ceil((INLINE_MAX_BYTES * 4) / 3));
		expect(INLINE_MAX_CHARS).toBeLessThan(INLINE_MAX_BYTES * 2);
	});
});
