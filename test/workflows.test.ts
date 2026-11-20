import { describe, expect, it } from "vitest";
import {
	parseWorkflow,
	triggersOnRelease,
	triggersOnTagCreation,
	workflowRunChain,
	workflowRunSources,
} from "../src/github/workflows";
import { aliasBomb } from "./fixtures";

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

describe("quote-aware parsing", () => {
	it.each([
		[
			"a quoted bracket in a multi-line flow mapping",
			"on: { push: { tags: ['v[0-9]*'] },\n  release: {} }\njobs: {}\n",
			true,
			true,
		],
		[
			"a quoted brace in a flow sequence",
			'on: { push: { tags: ["v{1,2}*"] } }\njobs:\n  release: {}\n',
			false,
			true,
		],
		[
			"a quoted closing bracket",
			"on: { push: { branches: ['main]'] } }\njobs:\n  release: {}\n",
			false,
			false,
		],
	])("handles %s", (_, yaml, release, tag) => {
		expect(triggersOnRelease(yaml)).toBe(release);
		expect(triggersOnTagCreation(yaml)).toBe(tag);
	});

	it("treats invalid YAML as no workflow", () => {
		expect(parseWorkflow("on: [push\n")).toBeUndefined();
		expect(triggersOnRelease("on: [release\n")).toBe(false);
	});

	it("treats an alias bomb as unanalysable instead of throwing", () => {
		const yaml = aliasBomb();
		expect(() => parseWorkflow(yaml)).not.toThrow();
		expect(parseWorkflow(yaml)).toBeUndefined();
	});

	it("reads the workflow name", () => {
		expect(parseWorkflow("name: 'Deploy'\non: release\n")?.name).toBe("Deploy");
	});
});

describe("release activity types", () => {
	const deploy = "on:\n  release:\n    types: [released]\n";

	it("matches when no types are given", () => {
		expect(triggersOnRelease("on: release\n", ["prereleased"])).toBe(true);
		expect(triggersOnRelease("on:\n  release:\n", ["published"])).toBe(true);
	});

	it.each([
		["a full publish", ["published", "created", "released"], true],
		["a prerelease publish", ["published", "created", "prereleased"], false],
		["a promotion", ["edited", "released"], true],
	] as const)("matches types: [released] on %s as %s", (_, actions, expected) => {
		expect(triggersOnRelease(deploy, actions)).toBe(expected);
	});

	it("reads a scalar types value", () => {
		expect(triggersOnRelease("on:\n  release:\n    types: published\n", ["published"])).toBe(
			true,
		);
		expect(triggersOnRelease("on:\n  release:\n    types: deleted\n", ["published"])).toBe(
			false,
		);
	});

	it("ignores edited- and deleted-only workflows when publishing", () => {
		expect(
			triggersOnRelease("on: { release: { types: [edited, deleted] } }\n", [
				"published",
				"created",
				"released",
			]),
		).toBe(false);
	});
});

describe("workflow_run", () => {
	const parse = (yaml: string) => {
		const workflow = parseWorkflow(yaml);
		if (!workflow) {
			throw new Error("unparseable");
		}
		return workflow;
	};

	it("reads the workflows a workflow_run trigger waits for", () => {
		expect(
			workflowRunSources(parse("on:\n  workflow_run:\n    workflows: [Release]\n")),
		).toEqual(["Release"]);
		expect(workflowRunSources(parse("on:\n  workflow_run:\n    workflows: Release\n"))).toEqual(
			["Release"],
		);
		expect(workflowRunSources(parse("on: push\n"))).toBeUndefined();
	});

	it("follows chains up to three levels and ignores unrelated workflows", () => {
		const wf = (path: string, yaml: string) => ({ path, workflow: parse(yaml) });
		const release = wf("release.yml", "name: Release\non: release\n");
		const all = [
			release,
			wf("deploy.yml", "name: Deploy\non:\n  workflow_run:\n    workflows: [Release]\n"),
			wf("notify.yml", "name: Notify\non:\n  workflow_run:\n    workflows: [Deploy]\n"),
			wf("audit.yml", "name: Audit\non:\n  workflow_run:\n    workflows: [Notify]\n"),
			wf("deeper.yml", "name: Deeper\non:\n  workflow_run:\n    workflows: [Audit]\n"),
			wf("ci.yml", "name: CI\non:\n  workflow_run:\n    workflows: [Lint]\n"),
		];
		expect(workflowRunChain(all, [release]).map((w) => w.path)).toEqual([
			"deploy.yml",
			"notify.yml",
			"audit.yml",
		]);
	});
});
