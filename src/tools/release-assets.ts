/**
 * Tools for the files attached to a release: uploading, renaming and deleting
 * them. Listing them is `list_release_assets`, in ./releases.ts.
 *
 * Files are uploaded two ways:
 *
 * - **Upload links,** for real build artifacts. `create_release_asset_upload`
 *   returns a single-use link on this Worker and a curl command; the agent
 *   sends the file from its shell and the Worker streams it on to GitHub. The
 *   file never passes through the model. See src/uploads/.
 * - **Inline,** for small text files from clients with no shell: checksums,
 *   SBOMs, changelogs. `upload_release_asset` takes the content as an argument,
 *   up to INLINE_MAX_BYTES.
 *
 * Fetching a file from a URL is deliberately not offered: it would let a
 * caller make the Worker request any address it likes.
 */

import { z } from "zod";
import { publicUrl } from "../env";
import { gh } from "../github/client";
import { type GitHubRelease, type GitHubReleaseAsset, getMutableRelease } from "../github/releases";
import { compactReleaseAsset } from "../shape";
import {
	assertNameFree,
	assetNameProblem,
	findAsset,
	guessContentType,
	isContentType,
	uploadAsset,
} from "../uploads/assets";
import { MAX_LINK_UPLOAD_BYTES } from "../uploads/handler";
import {
	LINK_TTL_SECONDS,
	UPLOAD_PATH_PREFIX,
	createUploadLink,
	sweepUploadLinks,
} from "../uploads/links";
import { type Register, type ToolContext, actAs, repoPath, repoShape } from "./common";
import { releaseId } from "./releases";

/** The most an inline upload takes, after base64 decoding. */
export const INLINE_MAX_BYTES = 256 * 1024;

/**
 * The longest `content` string accepted, checked before anything is decoded.
 * Base64 takes four characters for every three bytes, and the slack leaves
 * room for line breaks in wrapped base64. UTF-8 text never has more bytes than
 * UTF-16 code units, so the precise byte check after decoding still applies.
 */
export const INLINE_MAX_CHARS = Math.ceil((INLINE_MAX_BYTES * 4) / 3) + 16;

const assetName = z
	.string()
	.superRefine((name, issue) => {
		const problem = assetNameProblem(name);
		if (problem) {
			issue.addIssue({ code: "custom", message: problem });
		}
	})
	.describe("The file name the asset gets on the release, e.g. 'app-linux-x64.tar.gz'");

const assetLabel = z
	.string()
	.max(255)
	.optional()
	.describe("Shown in place of the file name on the release page");

const contentType = z
	.string()
	.refine(isContentType, "Not a valid MIME type")
	.optional()
	.describe("The file's MIME type. Guessed from the name when not given.");

const assetId = z.number().int().positive().describe("The asset's numeric id");

const PUBLISHED_ASSET_NOTE =
	"Only on drafts unless `allow_published: true`, since people and update checkers may " +
	"already link to the asset. Published releases in repositories with immutable releases " +
	"cannot be changed at all.";

export function registerReleaseAssetTools(register: Register, ctx: ToolContext) {
	register(
		"create_release_asset_upload",
		{
			annotations: { destructiveHint: false },
			description:
				"Get a link for uploading ONE file to a release from your shell. Returns a " +
				"single-use link that expires in 15 minutes, and a ready-made curl command: " +
				"replace <path> with the file's path and run it. curl prints the new asset as " +
				"JSON, or an error saying what went wrong. Use this for build artifacts; the " +
				"file never passes through the conversation. Files up to 100 MB. Call once per " +
				"file. The machine running curl must be able to reach this server's host — if " +
				"curl reports a proxy refusal or a 403 from a proxy, the host has to be allowed " +
				"in that environment's network settings. Without a shell, use " +
				"upload_release_asset for small text files instead.",
			inputSchema: {
				...repoShape,
				release_id: releaseId,
				name: assetName,
				label: assetLabel,
				content_type: contentType,
				...actAs,
			},
		},
		async (a) => {
			if (!ctx.tenant.grant) {
				throw new Error(
					"This connection's token does not name its grant, so an upload link cannot " +
						"be tied to it. Reconnect the connector, or use upload_release_asset for " +
						"a small file.",
				);
			}

			const creds = ctx.creds.as(a.act_as);
			const release = await getMutableRelease(creds, a, a.release_id);
			await assertNameFree(creds, a, release, a.name);

			const type = a.content_type ?? guessContentType(a.name);
			const { secret, expiresAt } = await createUploadLink(ctx.env, {
				grant: ctx.tenant.grant,
				installationId: ctx.tenant.installationId,
				accountLogin: ctx.tenant.accountLogin,
				actor: a.act_as,
				userLogin: ctx.tenant.login,
				userToken: a.act_as === "user" ? await ctx.creds.user.token() : undefined,
				owner: a.owner,
				repo: a.repo,
				releaseId: a.release_id,
				name: a.name,
				label: a.label,
				contentType: type,
			});
			ctx.waitUntil(sweepUploadLinks(ctx.env));

			const url = `${publicUrl(ctx.env)}${UPLOAD_PATH_PREFIX}${secret}`;
			return {
				upload_url: url,
				method: "PUT",
				expires_at: new Date(expiresAt * 1000).toISOString(),
				expires_in_seconds: LINK_TTL_SECONDS,
				max_bytes: MAX_LINK_UPLOAD_BYTES,
				asset_name: a.name,
				content_type: type,
				release: { id: release.id, tag_name: release.tag_name, draft: release.draft },
				curl_command:
					`curl -sS --fail-with-body --upload-file <path> ` +
					`-H ${shellQuote(`Content-Type: ${type}`)} ${shellQuote(url)}`,
				notes: [
					"Replace <path> with the file's path. The link takes one file, once.",
					"--fail-with-body needs curl 7.76 or later. On older curl, drop it and " +
						"read the JSON it prints instead.",
					`The link works without any other credentials, so treat it as a secret ` +
						`until it is used or expires.`,
				],
			};
		},
	);

	register(
		"upload_release_asset",
		{
			annotations: { destructiveHint: false },
			description:
				"Attach a small file to a release by giving its content directly — for " +
				"checksums, SBOMs, changelogs and similar, up to 256 KB. Give text as-is, or " +
				"binary as base64 with `encoding: 'base64'`. For anything larger, or any file " +
				"already on disk where you have a shell, use create_release_asset_upload instead.",
			inputSchema: {
				...repoShape,
				release_id: releaseId,
				name: assetName,
				content: z
					.string()
					.max(
						INLINE_MAX_CHARS,
						"Inline content is limited to 256 KB. Use create_release_asset_upload " +
							"and send the file from a shell instead.",
					)
					.describe("The file's content"),
				encoding: z
					.enum(["utf8", "base64"])
					.default("utf8")
					.describe("How `content` is written: plain text, or base64 for binary files"),
				label: assetLabel,
				content_type: contentType,
				...actAs,
			},
		},
		async (a) => {
			const data = decode(a.content, a.encoding);
			if (data.length === 0) {
				throw new Error("The content is empty; GitHub does not accept empty assets.");
			}
			if (data.length > INLINE_MAX_BYTES) {
				throw new Error(
					`The content is ${data.length} bytes; inline uploads take at most ` +
						`${INLINE_MAX_BYTES} bytes (256 KB). Use create_release_asset_upload and ` +
						`send the file from a shell instead.`,
				);
			}

			const creds = ctx.creds.as(a.act_as);
			const release = await getMutableRelease(creds, a, a.release_id);
			await assertNameFree(creds, a, release, a.name);

			const asset = await uploadAsset(
				creds,
				{
					owner: a.owner,
					repo: a.repo,
					releaseId: a.release_id,
					name: a.name,
					label: a.label,
				},
				{
					data,
					length: data.length,
					contentType: a.content_type ?? guessContentType(a.name),
				},
			);

			return { uploaded: true, asset: compactReleaseAsset(asset) };
		},
	);

	register(
		"update_release_asset",
		{
			annotations: { destructiveHint: true },
			description:
				"Rename a release asset or change its label. Renaming changes its download URL, " +
				"breaking links to the old one. " +
				PUBLISHED_ASSET_NOTE,
			inputSchema: {
				...repoShape,
				release_id: releaseId.describe("The release the asset is attached to"),
				asset_id: assetId,
				name: assetName.optional(),
				label: z
					.string()
					.max(255)
					.optional()
					.describe("Shown in place of the file name. An empty string removes it."),
				allow_published: z
					.boolean()
					.default(false)
					.describe("Required to change an asset on a published release"),
				...actAs,
			},
		},
		async (a) => {
			if (a.name === undefined && a.label === undefined) {
				throw new Error("Give a new `name`, a new `label`, or both.");
			}

			const creds = ctx.creds.as(a.act_as);
			const { release, asset } = await assetOnRelease(creds, a);

			if (!release.draft && !a.allow_published) {
				throw new Error(
					`Release ${a.release_id} (${release.tag_name}) is published, and people may ` +
						`already link to ${asset.name}. Pass allow_published: true if changing it ` +
						`is intended.`,
				);
			}
			if (a.name !== undefined && a.name !== asset.name) {
				await assertNameFree(creds, a, release, a.name);
			}

			const updated = await gh<GitHubReleaseAsset>(
				creds,
				`${repoPath(a)}/releases/assets/${a.asset_id}`,
				{
					method: "PATCH",
					body: { name: a.name, label: a.label },
				},
			);

			return { asset: compactReleaseAsset(updated), previous_name: asset.name };
		},
	);

	register(
		"delete_release_asset",
		{
			annotations: { destructiveHint: true },
			description: "Delete a file from a release. " + PUBLISHED_ASSET_NOTE,
			inputSchema: {
				...repoShape,
				release_id: releaseId.describe("The release the asset is attached to"),
				asset_id: assetId,
				allow_published: z
					.boolean()
					.default(false)
					.describe("Required to delete an asset from a published release"),
				...actAs,
			},
		},
		async (a) => {
			const creds = ctx.creds.as(a.act_as);
			const { release, asset } = await assetOnRelease(creds, a);

			if (!release.draft && !a.allow_published) {
				throw new Error(
					`Release ${a.release_id} (${release.tag_name}) is published. Deleting ` +
						`${asset.name} breaks every link to it; pass allow_published: true if ` +
						`that is intended.`,
				);
			}

			await gh<void>(creds, `${repoPath(a)}/releases/assets/${a.asset_id}`, {
				method: "DELETE",
			});

			return {
				deleted: true,
				asset_id: a.asset_id,
				name: asset.name,
				release_id: a.release_id,
				was_draft: release.draft,
			};
		},
	);
}

/**
 * Fetches the release and confirms the asset is on it. Both asset endpoints
 * work from the asset id alone, but whether a change is allowed depends on the
 * release, which GitHub's asset object does not name.
 */
async function assetOnRelease(
	creds: Parameters<typeof getMutableRelease>[0],
	a: { owner: string; repo: string; release_id: number; asset_id: number },
): Promise<{ release: GitHubRelease; asset: GitHubReleaseAsset }> {
	const release = await getMutableRelease(creds, a, a.release_id);
	const asset = await findAsset(creds, a, release, { id: a.asset_id });
	if (!asset) {
		throw new Error(
			`Asset ${a.asset_id} is not attached to release ${a.release_id} ` +
				`(${release.tag_name}). list_release_assets shows the assets it has.`,
		);
	}
	return { release, asset };
}

export function decode(content: string, encoding: "utf8" | "base64"): Uint8Array {
	if (encoding === "utf8") {
		return new TextEncoder().encode(content);
	}

	// atob() throws a bare DOMException on anything malformed, so the shape is
	// checked here first. Padding is optional, but when present it must bring
	// the length to a multiple of four, which is where "ab=" fails.
	const compact = content.replace(/\s/g, "");
	const padded = compact.endsWith("=");
	if (
		!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
		(padded ? compact.length % 4 !== 0 : compact.length % 4 === 1)
	) {
		throw new Error("`content` is not valid base64.");
	}
	const binary = atob(compact);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Single-quotes a value for a POSIX shell. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
