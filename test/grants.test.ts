import { describe, expect, it } from "vitest";
import { grantIsActive, grantRefFromRequest } from "../src/auth/props";

const withAuth = (value?: string) =>
	new Request("https://example.com/mcp", {
		headers: value === undefined ? {} : { Authorization: value },
	});

describe("grantRefFromRequest", () => {
	it("reads the user and grant from a provider token", () => {
		expect(grantRefFromRequest(withAuth("Bearer gh-1-inst-2:abc:secret"))).toEqual({
			userId: "gh-1-inst-2",
			grantId: "abc",
		});
	});

	it.each([
		undefined,
		"Basic x",
		"Bearer only-one-part",
		"Bearer a:b",
		"Bearer :b:c",
		"Bearer a:b:c:d",
	])("returns nothing for %j", (value) => {
		expect(grantRefFromRequest(withAuth(value))).toBeUndefined();
	});
});

describe("grantIsActive", () => {
	const now = Math.floor(Date.now() / 1000);
	const grant = (id: string, expiresAt?: number) => ({
		id,
		clientId: "c",
		userId: "u",
		scope: [],
		metadata: {},
		createdAt: now,
		expiresAt,
	});
	// Two pages, so the search has to follow the cursor.
	const helpers = {
		async listUserGrants(_userId: string, options?: { cursor?: string }) {
			return options?.cursor === "page-2"
				? { items: [grant("later"), grant("expired", now - 1)] }
				: { items: [grant("first", now + 60)], cursor: "page-2" };
		},
	};

	it.each([
		["first", true],
		["later", true],
		["expired", false],
		["revoked", false],
	])("%s is %s", async (grantId, expected) => {
		expect(await grantIsActive(helpers, { userId: "u", grantId })).toBe(expected);
	});
});
