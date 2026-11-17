/**
 * The parts of GitHub's release and release asset payloads this server reads,
 * and the fetches the release tools and the upload handler share.
 *
 * The types are narrow on purpose: they name only the fields something here
 * uses, so a field nobody reads cannot be relied on by accident.
 */

import { type Repo, type TokenSource, gh, repoPath } from "./client";

export interface GitHubUser {
	login: string;
	type?: string;
}

export interface GitHubReleaseAsset {
	id: number;
	name: string;
	label: string | null;
	size: number;
	content_type: string;
	download_count: number;
	state: string;
	uploader: GitHubUser | null;
	created_at: string;
	updated_at: string;
	browser_download_url: string;
}

export interface GitHubRelease {
	id: number;
	tag_name: string;
	target_commitish: string;
	name: string | null;
	body: string | null;
	draft: boolean;
	prerelease: boolean;
	/** Reported only by repositories with immutable releases turned on. */
	immutable?: boolean;
	author: GitHubUser | null;
	created_at: string;
	updated_at?: string;
	published_at: string | null;
	html_url: string;
	assets?: GitHubReleaseAsset[];
}

export function getRelease(creds: TokenSource, a: Repo, id: number): Promise<GitHubRelease> {
	return gh<GitHubRelease>(creds, `${repoPath(a)}/releases/${id}`);
}

/**
 * Fetches a release and refuses one whose assets are locked: GitHub does not
 * let anything change on a published release in a repository with immutable
 * releases turned on.
 */
export async function getMutableRelease(
	creds: TokenSource,
	a: Repo,
	id: number,
): Promise<GitHubRelease> {
	const release = await getRelease(creds, a, id);
	if (release.immutable && !release.draft) {
		throw new Error(
			`Release ${id} (${release.tag_name}) is immutable: the repository locks ` +
				`releases once they are published, so its assets cannot be added, renamed or ` +
				`deleted. Attach files to a draft before publishing it.`,
		);
	}
	return release;
}
