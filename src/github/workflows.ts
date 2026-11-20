/**
 * Which GitHub Actions workflows a release change will start.
 *
 * `publish_release` and `promote_release` show this in their previews, so the
 * person approving can see the deploys and package publishes that follow.
 * Workflow files are parsed with a real YAML parser; only the top-level `on:`
 * and `name:` are read.
 *
 * Every gap fails safe: a file that cannot be read or parsed is listed as
 * unanalysed (it may still run), never silently dropped.
 */

import { parseDocument } from "yaml";
import { GitHubError, type Repo, type TokenSource, gh, repoPath } from "./client";

/** How many workflow files a report reads before giving up. */
export const MAX_WORKFLOW_FILES = 20;

/**
 * The `release` activity types GitHub sends.
 * https://docs.github.com/actions/reference/events-that-trigger-workflows#release
 */
export type ReleaseAction =
	| "published"
	| "unpublished"
	| "created"
	| "edited"
	| "deleted"
	| "prereleased"
	| "released";

export interface WorkflowRef {
	path: string;
	name?: string;
}

export interface WorkflowReport {
	/** Workflow files whose `on: release` matches one of the actions sent. */
	triggered_by_release: WorkflowRef[];
	/**
	 * Workflow files that start because the change creates the tag: `create`,
	 * or `push` with a tag filter or no ref filter. Only set when the tag does
	 * not exist yet.
	 */
	triggered_by_tag_creation?: WorkflowRef[];
	/**
	 * Workflow files at the ref with `on: workflow_run` naming one of the
	 * workflows above, directly or through a chain of them. GitHub reads these
	 * from the default branch, not the ref, so this is an approximation.
	 */
	triggered_by_workflow_run?: WorkflowRef[];
	/**
	 * Workflow files that could not be read or parsed. Whether they run is
	 * unknown — GitHub's parser may accept what this one rejects — so they are
	 * reported, and bound into the confirm token, as possibly starting.
	 */
	unanalysed?: string[];
	/** The `release` activity types this change sends. */
	release_actions: ReleaseAction[];
	files_checked: number;
	/** Set when there were more files than were read. */
	unchecked_files?: string[];
	note?: string;
}

interface GitHubContent {
	type: string;
	name: string;
	path: string;
	content?: string;
}

interface ParsedWorkflow {
	name?: string;
	events: Map<string, unknown>;
}

/**
 * Parses a workflow file's `name:` and the events its top-level `on:` names,
 * each with its settings (null when it has none). Returns undefined for a file
 * this parser cannot read: invalid YAML, or one that trips the parser's limits
 * (such as its cap on alias expansion). GitHub's own parser may still accept
 * it, so callers must treat undefined as "unknown", not "will not run".
 *
 * `on:` may be a scalar (`on: release`), a sequence (`on: [push, release]`) or
 * a mapping of events to their settings, in block or flow style.
 */
export function parseWorkflow(yaml: string): ParsedWorkflow | undefined {
	let root: unknown;
	try {
		const doc = parseDocument(yaml.replace(/^\uFEFF/, ""));
		if (doc.errors.length) {
			return undefined;
		}
		// toJS throws, rather than reporting an error, past maxAliasCount.
		root = doc.toJS();
	} catch {
		return undefined;
	}
	if (!isRecord(root)) {
		return { events: new Map() };
	}

	const events = new Map<string, unknown>();
	const on = root.on;
	if (typeof on === "string") {
		events.set(on, null);
	} else if (Array.isArray(on)) {
		for (const event of on) {
			if (typeof event === "string") {
				events.set(event, null);
			}
		}
	} else if (isRecord(on)) {
		for (const [event, settings] of Object.entries(on)) {
			events.set(event, settings ?? null);
		}
	}

	const name = typeof root.name === "string" ? root.name : undefined;
	return { name, events };
}

/**
 * The workflow names an `on: workflow_run` trigger waits for, or undefined
 * when the workflow has none. GitHub requires `workflows:`; a scalar counts as
 * a single name.
 */
export function workflowRunSources(workflow: ParsedWorkflow): string[] | undefined {
	if (!workflow.events.has("workflow_run")) {
		return undefined;
	}
	const settings = workflow.events.get("workflow_run");
	const names = isRecord(settings) ? settings.workflows : undefined;
	if (typeof names === "string") {
		return [names];
	}
	return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

/** GitHub follows `workflow_run` chains at most this many levels deep. */
const MAX_WORKFLOW_RUN_DEPTH = 3;

/**
 * The workflows that `workflow_run` would start after `started` complete,
 * following chains up to GitHub's depth limit. A workflow without a `name:`
 * is known to GitHub by its file path.
 */
export function workflowRunChain(
	all: { path: string; workflow: ParsedWorkflow }[],
	started: { path: string; workflow: ParsedWorkflow }[],
): { path: string; workflow: ParsedWorkflow }[] {
	const label = (w: { path: string; workflow: ParsedWorkflow }) => w.workflow.name ?? w.path;
	const seen = new Set(started.map((w) => w.path));
	const found: { path: string; workflow: ParsedWorkflow }[] = [];
	let frontier = started;
	for (let depth = 0; depth < MAX_WORKFLOW_RUN_DEPTH && frontier.length; depth++) {
		const names = new Set(frontier.map(label));
		frontier = all.filter(
			(w) =>
				!seen.has(w.path) &&
				(workflowRunSources(w.workflow) ?? []).some((name) => names.has(name)),
		);
		for (const w of frontier) {
			seen.add(w.path);
			found.push(w);
		}
	}
	return found;
}

/** The events a workflow's top-level `on:` names, each with its settings. */
export function workflowEvents(yaml: string): Map<string, unknown> {
	return parseWorkflow(yaml)?.events ?? new Map();
}

/**
 * Whether a workflow's `on:` starts on any of these `release` activity types.
 * A `release` trigger without `types:` runs for every one of them. Without
 * `actions`, any `release` trigger counts.
 */
export function triggersOnRelease(
	yaml: string | ParsedWorkflow,
	actions?: readonly ReleaseAction[],
): boolean {
	const events = typeof yaml === "string" ? workflowEvents(yaml) : yaml.events;
	if (!events.has("release")) {
		return false;
	}
	const types = activityTypes(events.get("release"));
	return !actions || !types || actions.some((action) => types.includes(action));
}

/**
 * Whether a workflow starts when a new tag is pushed: on `create`, or on
 * `push` unless its filters name only branches. GitHub runs a `push` workflow
 * for a tag when it has a `tags`/`tags-ignore` filter, or when it has no ref
 * filter at all; `paths` filters are not applied to tags.
 */
export function triggersOnTagCreation(yaml: string | ParsedWorkflow): boolean {
	const events = typeof yaml === "string" ? workflowEvents(yaml) : yaml.events;
	if (events.has("create")) {
		return true;
	}
	if (!events.has("push")) {
		return false;
	}
	const push = events.get("push");
	if (!isRecord(push)) {
		return true;
	}
	const has = (key: string) => key in push;
	return has("tags") || has("tags-ignore") || !(has("branches") || has("branches-ignore"));
}

/** An event's `types:` filter, or undefined when it has none (every type runs). */
function activityTypes(settings: unknown): string[] | undefined {
	if (!isRecord(settings) || settings.types === undefined || settings.types === null) {
		return undefined;
	}
	const types = settings.types;
	if (typeof types === "string") {
		return [types];
	}
	return Array.isArray(types)
		? types.filter((t): t is string => typeof t === "string")
		: undefined;
}

/**
 * Lists the workflows at `ref` that a release change will start. Best-effort:
 * a failure to read is reported, not thrown, because it must never stop a
 * release from being previewed.
 */
export async function releaseWorkflows(
	creds: TokenSource,
	a: Repo,
	ref: string,
	options: { actions: ReleaseAction[]; createsTag: boolean },
): Promise<WorkflowReport> {
	const { actions, createsTag } = options;
	let entries: GitHubContent[];
	try {
		entries = await gh<GitHubContent[]>(creds, `${repoPath(a)}/contents/.github/workflows`, {
			query: { ref },
		});
	} catch (error) {
		if (error instanceof GitHubError && error.status === 404) {
			return {
				triggered_by_release: [],
				release_actions: actions,
				files_checked: 0,
				note: "No workflows at this ref.",
			};
		}
		return {
			triggered_by_release: [],
			release_actions: actions,
			files_checked: 0,
			note: `Could not read .github/workflows, so the workflows this starts are unknown: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	const files = (Array.isArray(entries) ? entries : []).filter(
		(entry) => entry.type === "file" && /\.ya?ml$/i.test(entry.name),
	);
	const checked = files.slice(0, MAX_WORKFLOW_FILES);

	const results = await Promise.all(
		checked.map(async (file) => {
			let text: string;
			try {
				const content = await gh<GitHubContent>(
					creds,
					`${repoPath(a)}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`,
					{ query: { ref } },
				);
				text = decodeBase64(content.content ?? "");
			} catch {
				return { path: file.path, unreadable: true as const };
			}
			return { path: file.path, workflow: parseWorkflow(text) };
		}),
	);

	const parsed = results.flatMap((r) =>
		"workflow" in r && r.workflow ? [{ path: r.path, workflow: r.workflow }] : [],
	);
	const unreadable = results.filter((r) => "unreadable" in r).map((r) => r.path);
	const invalid = results
		.filter((r) => "workflow" in r && r.workflow === undefined)
		.map((r) => r.path);
	const select = (test: (workflow: ParsedWorkflow) => boolean) =>
		parsed.filter((r) => test(r.workflow));
	const refs = (list: { path: string; workflow: ParsedWorkflow }[]) =>
		list.map((r) => ({ path: r.path, name: r.workflow.name }));

	const byRelease = select((w) => triggersOnRelease(w, actions));
	const byTag = createsTag ? select(triggersOnTagCreation) : [];
	const byWorkflowRun = workflowRunChain(parsed, [...byRelease, ...byTag]);
	const usesWorkflowRun = parsed.some((r) => workflowRunSources(r.workflow) !== undefined);

	const unchecked = files.slice(MAX_WORKFLOW_FILES).map((file) => file.path);
	const unanalysed = [...unreadable, ...invalid];
	const notes: string[] = [];
	if (unreadable.length) {
		notes.push(`Could not read: ${unreadable.join(", ")}.`);
	}
	if (invalid.length) {
		notes.push(
			`Could not be analysed, so they may still run: ${invalid.join(", ")}. GitHub's ` +
				`workflow parser can accept files this one rejects.`,
		);
	}
	if (unchecked.length) {
		notes.push(`Only the first ${MAX_WORKFLOW_FILES} workflow files were checked.`);
	}
	if (usesWorkflowRun) {
		notes.push(
			"Some workflows run on `workflow_run`. GitHub reads those from the default " +
				"branch, not this commit, so triggered_by_workflow_run is based on the files " +
				"here and may differ from what actually runs.",
		);
	}

	return {
		triggered_by_release: refs(byRelease),
		triggered_by_tag_creation: createsTag ? refs(byTag) : undefined,
		triggered_by_workflow_run: byWorkflowRun.length ? refs(byWorkflowRun) : undefined,
		unanalysed: unanalysed.length ? unanalysed : undefined,
		release_actions: actions,
		files_checked: checked.length - unreadable.length,
		unchecked_files: unchecked.length ? unchecked : undefined,
		note: notes.length ? notes.join(" ") : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Contents API returns file bodies as base64 wrapped at 60 columns. */
function decodeBase64(encoded: string): string {
	const binary = atob(encoded.replace(/\s/g, ""));
	return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
