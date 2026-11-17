/**
 * What the asset tools and the upload link handler share: checking that a
 * release can still take files, finding an asset on it, and the upload itself.
 */

import { type Repo, type TokenSource, gh, ghUpload, repoPath } from "../github/client";
import type { GitHubRelease, GitHubReleaseAsset } from "../github/releases";

/** How many pages of assets `findAsset` reads before giving up. */
const MAX_ASSET_PAGES = 10;

/**
 * Asset names as GitHub stores them. GitHub quietly swaps some characters for
 * a dot, so names that would end up somewhere unexpected are refused up front
 * rather than uploaded under a name nobody asked for.
 */
export function assetNameProblem(name: string): string | undefined {
	if (!name.trim()) {
		return "An asset name cannot be blank.";
	}
	if (name.length > 255) {
		return "An asset name can be at most 255 characters.";
	}
	// oxlint-disable-next-line no-control-regex
	if (/[/\\\u0000-\u001f\u007f]/.test(name)) {
		return "An asset name cannot contain slashes or control characters.";
	}
	if (name === "." || name === "..") {
		return "An asset name cannot be '.' or '..'.";
	}
	return undefined;
}

/**
 * Finds an asset on a release by id or by name. A release's own `assets` array
 * is checked first; the paged list is read only if that misses, in case GitHub
 * cut the array short.
 */
export async function findAsset(
	creds: TokenSource,
	a: Repo,
	release: GitHubRelease,
	match: { id?: number; name?: string },
): Promise<GitHubReleaseAsset | undefined> {
	const matches = (asset: GitHubReleaseAsset) =>
		(match.id !== undefined && asset.id === match.id) ||
		(match.name !== undefined && asset.name === match.name);

	const inline = (release.assets ?? []).find(matches);
	if (inline) {
		return inline;
	}

	for (let page = 1; page <= MAX_ASSET_PAGES; page++) {
		const assets = await gh<GitHubReleaseAsset[]>(
			creds,
			`${repoPath(a)}/releases/${release.id}/assets`,
			{
				query: { per_page: 100, page },
			},
		);
		const found = assets.find(matches);
		if (found || assets.length < 100) {
			return found;
		}
	}
	return undefined;
}

/** Refuses a name already taken on the release, which GitHub answers with a bare 422. */
export async function assertNameFree(
	creds: TokenSource,
	a: Repo,
	release: GitHubRelease,
	name: string,
): Promise<void> {
	const existing = await findAsset(creds, a, release, { name });
	if (existing) {
		throw new Error(
			`Release ${release.id} (${release.tag_name}) already has an asset named ${name} ` +
				`(id ${existing.id}). Delete it with delete_release_asset first, or choose ` +
				`another name.`,
		);
	}
}

export function uploadAsset(
	creds: TokenSource,
	a: Repo & { releaseId: number; name: string; label?: string },
	body: { data: ReadableStream<Uint8Array> | Uint8Array; length: number; contentType: string },
): Promise<GitHubReleaseAsset> {
	return ghUpload<GitHubReleaseAsset>(
		creds,
		`${repoPath(a)}/releases/${a.releaseId}/assets`,
		{ name: a.name, label: a.label },
		body,
	);
}

const CONTENT_TYPES: [RegExp, string][] = [
	[/\.(tar\.gz|tgz)$/i, "application/gzip"],
	[/\.gz$/i, "application/gzip"],
	[/\.zip$/i, "application/zip"],
	[/\.tar$/i, "application/x-tar"],
	[/\.(tar\.xz|xz)$/i, "application/x-xz"],
	[/\.(tar\.bz2|bz2)$/i, "application/x-bzip2"],
	[/\.(tar\.zst|zst)$/i, "application/zstd"],
	[/\.7z$/i, "application/x-7z-compressed"],
	[/\.json$/i, "application/json"],
	[/\.(ya?ml)$/i, "application/yaml"],
	[/\.xml$/i, "application/xml"],
	[/\.pdf$/i, "application/pdf"],
	[/\.wasm$/i, "application/wasm"],
	[/\.(md|markdown)$/i, "text/markdown"],
	[/\.html?$/i, "text/html"],
	[/\.csv$/i, "text/csv"],
	[/\.(txt|log|sha256|sha512|sha1|md5|sum|asc|sig)$/i, "text/plain"],
	[/(^|[._-])(checksums|sha\d*sums)([._-]|$)/i, "text/plain"],
	[/\.png$/i, "image/png"],
	[/\.jpe?g$/i, "image/jpeg"],
	[/\.svg$/i, "image/svg+xml"],
	[/\.dmg$/i, "application/x-apple-diskimage"],
	[/\.deb$/i, "application/vnd.debian.binary-package"],
	[/\.rpm$/i, "application/x-rpm"],
	[/\.apk$/i, "application/vnd.android.package-archive"],
	[/\.jar$/i, "application/java-archive"],
	[/\.msi$/i, "application/x-msi"],
];

/** A content type for a file name, falling back to a generic binary type. */
export function guessContentType(name: string): string {
	return CONTENT_TYPES.find(([pattern]) => pattern.test(name))?.[1] ?? "application/octet-stream";
}

/** Loose, since GitHub stores whatever it is given; this only stops header injection. */
export function isContentType(value: string): boolean {
	return /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(value);
}
