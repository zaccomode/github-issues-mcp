/**
 * The browser-facing pages of the handshake.
 *
 * Every interpolated value is escaped. Dynamic client registration is open —
 * anyone can register a client and walk a user through this flow — so the
 * consent page has to name the client *and* show where it will be redirected,
 * or the user has no way to spot a confused-deputy attempt.
 */

import type { ClientInfo } from "@cloudflare/workers-oauth-provider";
import { escapeHtml, page } from "../http";
import type { UserInstallation } from "./user-oauth";

export function consentPage(client: ClientInfo, action: string, error?: string): string {
	const clientName = escapeHtml(client.clientName || client.clientId);
	const redirects = (client.redirectUris ?? [])
		.map((uri) => `<li><code>${escapeHtml(uri)}</code></li>`)
		.join("");

	return page(
		"Connect to GitHub Issues",
		`  <h1>Connect to GitHub Issues</h1>
  <p><strong>${clientName}</strong> is asking to read and write GitHub issues on your
  behalf. Continue to sign in with GitHub and choose which account's issues it can
  reach.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <p class="hint">After authorising, it will be sent back to:</p>
  <ul class="plain">${redirects}</ul>
  <form method="post" action="${escapeHtml(action)}">
    <button type="submit">Continue with GitHub</button>
  </form>
  <p class="hint">Writes are attributed to the app's bot account by default, so you can
  always tell what an agent changed. Nothing is ever posted as you unless a tool
  explicitly asks for it.</p>`,
	);
}

/** Shown when the user has not installed the App on any account yet. */
export function installPage(installUrl: string): string {
	return page(
		"Install the app",
		`  <h1>One more step</h1>
  <p>The GitHub App isn't installed on any account you can reach yet. Install it on the
  account whose issues you want this connector to work with, and choose which
  repositories it can see.</p>
  <form method="get" action="${escapeHtml(installUrl)}">
    <button type="submit">Install on GitHub</button>
  </form>
  <p class="hint">You'll come straight back here afterwards.</p>`,
	);
}

/**
 * Shown when the user can reach more than one installation. The chosen id is
 * re-checked against this same list server-side — the form is a convenience,
 * not the authority.
 */
export function pickerPage(
	installations: UserInstallation[],
	state: string,
	installUrl: string,
): string {
	const options = installations
		.map((installation) => {
			const scope =
				installation.repositorySelection === "all"
					? "all repositories"
					: "selected repositories";
			return `    <button class="choice" type="submit" name="installation_id" value="${escapeHtml(
				String(installation.id),
			)}">
      <strong>${escapeHtml(installation.accountLogin)}</strong>
      <span>${escapeHtml(installation.accountType)} · ${escapeHtml(scope)}</span>
    </button>`;
		})
		.join("\n");

	return page(
		"Choose an account",
		`  <h1>Choose an account</h1>
  <p>The app is installed on more than one account. Pick the one this connector should
  work with.</p>
  <form method="post" action="/select">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
${options}
  </form>
  <p class="hint">Want a different account? <a href="${escapeHtml(installUrl)}">Install it
  there first</a>.</p>`,
	);
}

/**
 * Reached when someone installs the App straight from GitHub rather than from an
 * MCP client. There is no authorization in flight to complete, so the only
 * useful thing to do is tell them where the server lives.
 */
export function installedPage(mcpUrl: string): string {
	return page(
		"Installed",
		`  <h1>Installed</h1>
  <p>The GitHub App is installed. To use it, add this URL as an MCP server in your
  client:</p>
  <ul class="plain"><li><code>${escapeHtml(mcpUrl)}</code></li></ul>
  <p class="hint">Your client will walk you through signing in the first time it
  connects.</p>`,
	);
}

export function landingPage(mcpUrl: string): string {
	return page(
		"GitHub Issues MCP",
		`  <h1>GitHub Issues MCP</h1>
  <p>An MCP server for reading and writing GitHub issues, where an agent's changes are
  attributed to a bot account rather than to you.</p>
  <ul class="plain"><li><code>${escapeHtml(mcpUrl)}</code></li></ul>
  <p class="hint">Add that URL as an MCP server in your client and it will take you
  through connecting your GitHub account.</p>`,
	);
}

export function errorPage(title: string, message: string): string {
	return page(
		escapeHtml(title),
		`  <h1>${escapeHtml(title)}</h1>
  <div class="error">${escapeHtml(message)}</div>`,
	);
}
