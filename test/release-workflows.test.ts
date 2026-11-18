import { describe, expect, it } from "vitest";
import {
	isPlaceholderTag,
	publishToken,
	pullRequestNumbers,
	releasePatch,
	triggersOnRelease,
	triggersOnTagCreation,
} from "../src/tools/releases";

describe("triggersOnRelease", () => {
	const runs = (yaml: string) => triggersOnRelease(yaml.replace(/^\n/, ""));

	it.each([
		["a scalar", "on: release\n"],
		["a quoted key", '"on": release\n'],
		["a flow sequence", "on: [push, release]\n"],
		["a quoted flow entry", "on: ['push', \"release\"]\n"],
		["a flow mapping", "on: { push: { branches: [main] }, release: { types: [published] } }\n"],
		["a block key", "on:\n  release:\n    types: [published]\n"],
		["a bare block key", "on:\n  push:\n  release:\n"],
		["a block list item", "on:\n  - push\n  - release\n"],
		["a block list at column 0", "on:\n- push\n- release\njobs: {}\n"],
		["a comment between entries", "on:\n  push:\n  # the next one\n  release:\n"],
		["a trailing comment", "on: release # publish\n"],
		["a flow sequence over two lines", "on: [push,\n  release]\njobs: {}\n"],
		["a flow mapping over three lines", "on: {\n  release: { types: [published] }\n}\n"],
		["a leading byte order mark", "\uFEFFon: release\n"],
	])("matches %s", (_, yaml) => {
		expect(runs(yaml)).toBe(true);
	});

	it.each([
		["a branch filter under push", "on:\n  push:\n    branches:\n      - release\n"],
		["a branch key under push", "on:\n  push:\n    branches:\n      release:\n"],
		["a flow branch filter", "on: { push: { branches: [release] } }\n"],
		["a job named release", "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n"],
		["a block job named release", "on:\n  push:\njobs:\n  release:\n"],
		["a similar event", "on: [release_candidate, push]\n"],
		["a commented-out event", "on:\n  push:\n  # release:\n"],
		["no on: at all", "name: x\njobs: {}\n"],
		["an inline comment naming it", "on: push # not release\n"],
	])("ignores %s", (_, yaml) => {
		expect(runs(yaml)).toBe(false);
	});
});

describe("triggersOnTagCreation", () => {
	const runs = (yaml: string) => triggersOnTagCreation(yaml.replace(/^\n/, ""));

	it.each([
		["a block tag filter", "on:\n  push:\n    tags: ['v*']\n"],
		["a tags-ignore filter", "on:\n  push:\n    tags-ignore:\n      - nightly\n"],
		["a flow tag filter", "on: { push: { tags: [v*] } }\n"],
		["branches and tags", "on:\n  push:\n    branches: [main]\n    tags: [v*]\n"],
		["a bare push", "on: push\n"],
		["a bare push in a list", "on: [push, pull_request]\n"],
		["a push with only paths", "on:\n  push:\n    paths: [src/**]\n"],
		["a create event", "on: [create]\n"],
		["a multi-line flow push", "on: {\n  push: { tags: [v*] }\n}\n"],
	])("matches %s", (_, yaml) => {
		expect(runs(yaml)).toBe(true);
	});

	it.each([
		["a branch-only push", "on:\n  push:\n    branches: [main]\n"],
		["a branches-ignore push", "on:\n  push:\n    branches-ignore: [wip]\n"],
		["a flow branch-only push", "on: { push: { branches: [main] } }\n"],
		["a release only", "on:\n  release:\n    types: [published]\n"],
		["a job filter named tags", "on:\n  push:\n    branches: [main]\njobs:\n  tags:\n"],
	])("ignores %s", (_, yaml) => {
		expect(runs(yaml)).toBe(false);
	});
});

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

describe("publishToken", () => {
	const release = {
		id: 1,
		tag_name: "v1.0.0",
		target_commitish: "main",
		name: "v1.0.0",
		body: "notes",
		prerelease: false,
		updated_at: "2026-11-17T00:00:00Z",
	};

	it("is stable for the same inputs", async () => {
		expect(await publishToken(release, "abc", undefined, "app")).toBe(
			await publishToken({ ...release }, "abc", undefined, "app"),
		);
	});

	it.each([
		["the commit", () => publishToken(release, "def", undefined, "app")],
		["the notes", () => publishToken({ ...release, body: "changed" }, "abc", undefined, "app")],
		[
			"the tag",
			() => publishToken({ ...release, tag_name: "v1.0.1" }, "abc", undefined, "app"),
		],
		[
			"updated_at",
			() =>
				publishToken(
					{ ...release, updated_at: "2026-11-18T00:00:00Z" },
					"abc",
					undefined,
					"app",
				),
		],
		["make_latest", () => publishToken(release, "abc", "true", "app")],
		["the actor", () => publishToken(release, "abc", undefined, "user")],
	])("changes with %s", async (_, other) => {
		expect(await other()).not.toBe(await publishToken(release, "abc", undefined, "app"));
	});
});
