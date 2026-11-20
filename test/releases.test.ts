import { describe, expect, it } from "vitest";
import {
	confirmToken,
	isPlaceholderTag,
	publishActions,
	pullRequestNumbers,
	releasePatch,
} from "../src/tools/releases";

describe("releasePatch", () => {
	const draft = { draft: true, tag_name: "v2.4.0", target_commitish: "main" };

	it("keeps a draft's tag when only the body changes", () => {
		const { patch, warning } = releasePatch(draft, { body: "notes" });
		expect(patch).toMatchObject({
			body: "notes",
			tag_name: "v2.4.0",
			target_commitish: "main",
		});
		expect(warning).toBeUndefined();
	});

	it("keeps a draft's tag when only target_commitish changes", () => {
		const { patch } = releasePatch(draft, { target_commitish: "abc123" });
		expect(patch).toMatchObject({ tag_name: "v2.4.0", target_commitish: "abc123" });
	});

	it("sends a new tag as given", () => {
		const { patch } = releasePatch(draft, { tag_name: "v3.0.0", target_commitish: "dev" });
		expect(patch).toMatchObject({ tag_name: "v3.0.0", target_commitish: "dev" });
	});

	it("leaves a published release's tag alone", () => {
		const { patch } = releasePatch({ ...draft, draft: false }, { body: "notes" });
		expect(patch.tag_name).toBeUndefined();
		expect(patch.target_commitish).toBeUndefined();
	});

	it("warns rather than re-sending a placeholder tag", () => {
		const { patch, warning } = releasePatch(
			{ ...draft, tag_name: "untagged-24962f94d18b366c8863" },
			{ body: "notes" },
		);
		expect(patch.tag_name).toBeUndefined();
		expect(warning).toMatch(/no tag/);
	});

	it("recognises placeholder tags", () => {
		expect(isPlaceholderTag("untagged-8ed02a1b9605b4006bbf")).toBe(true);
		expect(isPlaceholderTag("v2.3.0")).toBe(false);
		expect(isPlaceholderTag("untagged-build")).toBe(false);
		expect(isPlaceholderTag("untagged-24962f94d18b366c8863-rc")).toBe(false);
	});

	it("re-sends a real tag that starts with untagged-", () => {
		const { patch, warning } = releasePatch(
			{ ...draft, tag_name: "untagged-build" },
			{ body: "notes" },
		);
		expect(patch.tag_name).toBe("untagged-build");
		expect(warning).toBeUndefined();
	});
});

describe("pullRequestNumbers", () => {
	const commit = (message: string) => ({ sha: "x", commit: { message } });

	it("finds squash and merge commits, deduplicated and sorted", () => {
		expect(
			pullRequestNumbers([
				commit("Add a thing (#12)\n\nBody (#99)"),
				commit("Merge pull request #7 from someone/branch"),
				commit("Another (#12)"),
				commit("No number here"),
				commit("Mentions #5 mid-line"),
				{ sha: "y" },
			]),
		).toEqual([7, 12]);
	});
});

describe("confirmToken", () => {
	const release = {
		id: 1,
		tag_name: "v1.0.0",
		target_commitish: "main",
		name: "v1.0.0",
		body: "notes",
		prerelease: false,
		updated_at: "2026-11-17T00:00:00Z",
	};
	const state = {
		sha: "abc",
		tagExists: false,
		makeLatest: undefined as string | undefined,
		actor: "app",
		workflows: {
			triggered_by_release: [{ path: ".github/workflows/deploy.yml" }],
			triggered_by_tag_creation: [],
		},
	};
	const base = () => confirmToken("publish", release, state);

	it("is stable for the same inputs", async () => {
		expect(await base()).toBe(await confirmToken("publish", { ...release }, { ...state }));
	});

	it.each([
		["the commit", () => confirmToken("publish", release, { ...state, sha: "def" })],
		["the notes", () => confirmToken("publish", { ...release, body: "changed" }, state)],
		["the tag", () => confirmToken("publish", { ...release, tag_name: "v1.0.1" }, state)],
		[
			"updated_at",
			() =>
				confirmToken("publish", { ...release, updated_at: "2026-11-18T00:00:00Z" }, state),
		],
		["make_latest", () => confirmToken("publish", release, { ...state, makeLatest: "true" })],
		["the actor", () => confirmToken("publish", release, { ...state, actor: "user" })],
		[
			"whether the tag exists",
			() => confirmToken("publish", release, { ...state, tagExists: true }),
		],
		[
			"the workflows listed",
			() =>
				confirmToken("publish", release, {
					...state,
					workflows: { ...state.workflows, triggered_by_release: [] },
				}),
		],
		[
			"the workflow_run chain",
			() =>
				confirmToken("publish", release, {
					...state,
					workflows: {
						...state.workflows,
						triggered_by_workflow_run: [{ path: ".github/workflows/after.yml" }],
					},
				}),
		],
		[
			"the unanalysed files",
			() =>
				confirmToken("publish", release, {
					...state,
					workflows: { ...state.workflows, unanalysed: [".github/workflows/odd.yml"] },
				}),
		],
		["the action", () => confirmToken("promote", release, state)],
	])("changes with %s", async (_, other) => {
		expect(await other()).not.toBe(await base());
	});
});

describe("publishActions", () => {
	it("sends released for a full release and neither for a prerelease", () => {
		expect(publishActions(false)).toContain("released");
		expect(publishActions(false)).not.toContain("prereleased");
		// GitHub sends only `published` for a prerelease published from a draft.
		expect(publishActions(true)).toEqual(["published", "created"]);
	});
});
