import { describe, expect, it } from "vitest";
import { publishToken, pullRequestNumbers, triggersOnRelease } from "../src/tools/releases";

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
