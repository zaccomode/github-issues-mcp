/**
 * Receives a file sent to an upload link and streams it on to GitHub.
 *
 * Reached without an MCP token: the link's secret, sent as a bearer token, is
 * the only authorisation, which is why it is single-use, short-lived and bound
 * to one release and one asset name when it is made. The URL carries only the
 * link's id, so request logs never hold a usable link. Everything about where the file goes and who it
 * is uploaded as comes from the stored link, never from this request.
 *
 * Answers are JSON for an agent reading curl's output, so every failure says
 * what to do next.
 */

import { installationTokenSource } from "../auth/installation";
import { grantIsActive } from "../auth/props";
import { installationStatus } from "../db/tenants";
import type { AppEnv } from "../env";
import { GitHubError, ISSUE_422_HINT, type TokenSource } from "../github/client";
import { compactReleaseAsset } from "../shape";
import { scrub } from "../tools/common";
import { getMutableRelease } from "../github/releases";
import { isContentType, uploadAsset } from "./assets";
import { type ClaimedUploadLink, UPLOAD_PATH_PREFIX, claimUploadLink, uploadLinkId } from "./links";

/**
 * Cloudflare refuses request bodies over 100 MB on the Free and Pro plans
 * (https://developers.cloudflare.com/workers/platform/limits/), which is what
 * a workers.dev host gets. Checking here gives a clearer answer than the edge's
 * bare 413, and does it before the link is spent.
 */
export const MAX_LINK_UPLOAD_BYTES = 100 * 1024 * 1024;

const NEW_LINK = "Make a new link with create_release_asset_upload and send the file again.";

const ASSET_422_HINT =
	"The asset name may already be taken on this release, or the file may be empty.";

export async function handleUpload(request: Request, env: AppEnv): Promise<Response> {
	try {
		return await receive(request, env);
	} catch (error) {
		// A D1 or KV failure. Whether the link was spent depends on where it
		// happened, so the advice covers both.
		console.error("uploads: unexpected failure", error);
		return reply(500, {
			error:
				"The upload failed on this server before reaching GitHub. Try the same link " +
				`again; if it says the link was used, ${NEW_LINK[0].toLowerCase()}${NEW_LINK.slice(1)}`,
		});
	}
}

async function receive(request: Request, env: AppEnv): Promise<Response> {
	if (request.method !== "PUT" && request.method !== "POST") {
		return reply(
			405,
			{ error: "Send the file with PUT (curl --upload-file) or POST." },
			{
				Allow: "PUT, POST",
			},
		);
	}

	const id = new URL(request.url).pathname.slice(UPLOAD_PATH_PREFIX.length);
	if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
		// A link from before secrets moved out of the URL. It expires within
		// fifteen minutes of being made, and accepting it would keep the old hole.
		return reply(410, {
			error: `This upload link uses a format this server no longer accepts. ${NEW_LINK}`,
		});
	}
	if (!/^[0-9a-f]{64}$/.test(id)) {
		return reply(404, { error: `This is not an upload link. ${NEW_LINK}` });
	}

	const secret = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
	if (secret === undefined || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
		return reply(
			401,
			{
				error:
					"The upload needs the link's secret in an `Authorization: Bearer` header. " +
					"Use the curl_command create_release_asset_upload returned. The link has " +
					"not been used.",
			},
			{ "WWW-Authenticate": 'Bearer realm="upload link"' },
		);
	}
	if ((await uploadLinkId(secret)) !== id) {
		return reply(404, {
			error: `The secret does not belong to this upload link. ${NEW_LINK}`,
		});
	}

	// Everything that can be checked without spending the link is checked first.
	const declared = request.headers.get("content-length");
	if (declared === null || !/^\d+$/.test(declared)) {
		return reply(411, {
			error:
				"The upload needs a Content-Length header. Send a file with " +
				"`curl --upload-file <path>` rather than piping from stdin. The link has not " +
				"been used.",
		});
	}
	const length = Number(declared);
	if (length === 0 || !request.body) {
		return reply(400, { error: "The file is empty. The link has not been used." });
	}
	if (length > MAX_LINK_UPLOAD_BYTES) {
		return reply(413, {
			error:
				`The file is ${length} bytes; upload links take at most ${MAX_LINK_UPLOAD_BYTES} ` +
				`bytes (100 MB). The link has not been used.`,
		});
	}

	const contentType = request.headers.get("content-type");
	if (contentType !== null && !isContentType(contentType)) {
		return reply(400, {
			error: `Content-Type ${JSON.stringify(contentType)} is not valid. The link has not been used.`,
		});
	}

	const claim = await claimUploadLink(env, secret);
	if (!claim.ok) {
		const why = {
			unknown: [404, "This upload link does not exist."],
			used: [410, "This upload link has already been used; each link takes one file."],
			expired: [410, "This upload link has expired."],
			unreadable: [
				410,
				"This upload link was made before a change to this server and can no longer " +
					"act as the user.",
			],
		} as const;
		const [status, message] = why[claim.reason];
		return reply(status, { error: `${message} ${NEW_LINK}` });
	}
	const link = claim.link;

	// The installation may have been suspended or removed since the link was made.
	const status = await installationStatus(env, link.installationId);
	if (status !== "active") {
		return reply(403, {
			error:
				`The GitHub App installation for ${link.accountLogin} is ${status}, so nothing ` +
				`was uploaded. Reinstall the app and reconnect the connector.`,
		});
	}

	// The grant that made the link may have been revoked since: the person
	// disconnected the connector, or the grant expired. Links made before
	// grants were recorded name none, and are refused for the same reason.
	if (!link.grant || !(await grantIsActive(env.OAUTH_PROVIDER, link.grant))) {
		return reply(403, {
			error:
				"The connection that made this upload link has been disconnected or has " +
				"expired, so nothing was uploaded. Reconnect the connector, then make a new " +
				"link.",
		});
	}

	const creds = sourceFor(env, link);
	const where = `${link.owner}/${link.repo}`;

	try {
		// Re-checked now rather than trusted from when the link was made: the
		// release may have been published or deleted since. The request also
		// renews a stale token, which the upload itself cannot retry with.
		await getMutableRelease(creds, link, link.releaseId);

		const asset = await uploadAsset(creds, link, {
			data: request.body,
			length,
			contentType: contentType ?? link.contentType,
		});

		return reply(201, {
			uploaded: true,
			repository: where,
			release_id: link.releaseId,
			uploaded_as: link.actor === "app" ? botLogin(env) : link.userLogin,
			asset: compactReleaseAsset(asset),
		});
	} catch (error) {
		if (error instanceof GitHubError) {
			const message = error.message.replace(ISSUE_422_HINT, ASSET_422_HINT);
			return reply(error.status >= 400 && error.status < 500 ? error.status : 502, {
				error: scrub(`Nothing was uploaded to ${where}. ${message} ${NEW_LINK}`),
			});
		}
		const message = error instanceof Error ? error.message : String(error);
		// A refusal from getMutableRelease, or the body ending early.
		return reply(409, {
			error: scrub(`Nothing was uploaded to ${where}. ${message}`),
		});
	}
}

function botLogin(env: AppEnv): string {
	return `${env.GITHUB_APP_SLUG}[bot]`;
}

function sourceFor(env: AppEnv, link: ClaimedUploadLink): TokenSource {
	if (link.actor === "app") {
		return installationTokenSource(
			env,
			link.installationId,
			`the GitHub App (${botLogin(env)}) installed on ${link.accountLogin}`,
		);
	}

	const token = link.userToken!;
	return {
		kind: "user",
		label: `the GitHub account @${link.userLogin}`,
		async token() {
			return token;
		},
		// As everywhere else, a user token is never refreshed outside
		// tokenExchangeCallback; see TokenSource.renew in src/github/client.ts.
		async renew() {
			return null;
		},
	};
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(`${JSON.stringify(body, null, 2)}\n`, {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			...headers,
		},
	});
}
