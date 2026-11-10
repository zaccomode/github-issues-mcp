# github-issues-mcp

A remote, Cloudflare Workers-based MCP server to manage GitHub issues, deployed as a GitHub app so that an agent's changes are attributable.

This MCP server exists because the official GitHub MCP server must be run locally to connect to Claude Desktop, thus preventing it from properly working with Claude's cloud agent functionality. This works anywhere an MCP server is accepted, without all the fiddling the official one currently requires.

> **This is an app you can install yourself!** I'm hosting a public version here that you can install to your account without having to host it yourself, giving you 5,000 requests an hour.
>
> https://github.com/apps/claude-issues-mcp

## Tools

`whoami`, `list_issues`, `get_issue`, `search_issues`, `create_issue`,
`update_issue`, `list_issue_comments`, `add_issue_comment`,
`update_issue_comment`, `list_labels`, `add_issue_labels`, `remove_issue_label`,
`list_pull_requests`, `get_pull_request`, `create_pull_request`,
`update_pull_request`.

Security (read-only): `list_dependabot_alerts`, `get_dependabot_alert`,
`list_code_scanning_alerts`, `get_code_scanning_alert`,
`list_secret_scanning_alerts`, `get_secret_scanning_alert`,
`list_security_advisories`, `get_security_advisory`.

The eight write tools accept `act_as`. Reads always run as the signed-in person,
so what an agent can see matches what you can see — which does mean
`search_issues` can surface issues in repositories the write tools cannot touch.
`whoami` reports both identities and where the App is actually installed.

Because GitHub's REST API treats pull requests as issues, the issue tools also
work on a PR number: `add_issue_comment` posts to the PR conversation, and the
label tools apply to it.

### Acting

Every write tool accepts `act_as`:

- `act_as: "app"` (default) posts as the app's bot account, so that PRs, comments and issues created by your agents are marked as such and not you.
- `act_as: "user"` posts as the person who authorised the connection, badged as coming via the app.

### Linking Pull Requests to Issues

`create_pull_request` and `update_pull_request` take a `closes: [12, 13]` argument, which appends the text "Closes #12, #13", etc. to the PR body such that it correctly links to issues you're working on.

This exists because GitHub has no API for linking PRs to issues, but does this implicitly when it detects a closing keywork in the PR body.

### Security Alerts

The security tools read a repository's Dependabot alerts, code scanning alerts,
secret scanning alerts and security advisories. Privately reported
vulnerabilities arrive as advisories in the `triage` state, marked
`reported_privately: true`.

- **Read-only.** Dismissing alerts and accepting, closing or publishing
  advisories are left to a person in GitHub's UI.
- **Secret values are never returned.** Secret scanning is asked to hide them,
  and the result is built from an allowlist of fields that does not include the
  secret, so it cannot leak even if GitHub sends it anyway.
- **Untrusted text is labelled.** Advisory descriptions are written by outside
  reporters, and analysis messages can quote code from any contributor. Results
  name these fields in `untrusted_fields` so an agent treats them as data, not
  instructions.
- **Lists page by cursor.** Pass a result's `next_cursor` back as `cursor` to
  fetch the next page.

They need extra App permissions (see [Setting it up](#setting-it-up)), and the
person signed in must be able to see the alerts on GitHub themselves, which
usually means write access or above. Code scanning and secret scanning must also be turned on for the
repository; on private repositories they need GitHub Code Security and Secret
Protection. Each of these failures gets its own explanation in the tool error.

## Setting it up

### 1. Register a GitHub App

<https://github.com/settings/apps/new>

| Setting                                                | Value                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Callback URL                                           | `https://<your-host>/callback`                                                     |
| Request user authorization (OAuth) during installation | **on**                                                                             |
| Expire user authorization tokens                       | **on**                                                                             |
| Setup URL                                              | leave blank                                                                        |
| Webhook URL                                            | `https://<your-host>/webhooks/github`                                              |
| Repository permissions                                 | Issues: **read & write**; Pull requests: **read & write**; Metadata: **read-only** |
| Where can this be installed                            | **Any account**                                                                    |

The security tools also need these repository permissions at **read-only**:
Dependabot alerts, Code scanning alerts, Secret scanning alerts, and Repository
security advisories. Without them those tools fail with an explanation and
everything else works as before.

Then generate a private key and convert it, because WebCrypto cannot import the
PKCS#1 key GitHub hands you:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in app.private-key.pem -out app.pkcs8.pem
```

### 2. Create the bindings

```bash
npx wrangler kv namespace create CACHE
npx wrangler d1 create github-issues-mcp
```

Put the returned ids into `wrangler.jsonc` (they replace the two `PLACEHOLDER_…`
values), fill in `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID` and
`PUBLIC_URL`, then:

```bash
npm run cf-typegen
npm run db:migrate
```

### 3. Set the secrets

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem
```

To rotate the private key with no downtime: add a second key on GitHub, run
`wrangler secret put`, verify, then delete the old one.

### 4. Deploy

```bash
npm run deploy
```

Add `https://<your-host>/mcp` to any MCP client.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in. Register a **separate dev
GitHub App** pointed at `http://localhost:8787/callback` rather than repointing
the production one — that keeps the production private key off your machine.

```bash
npm run db:migrate:local
npm run dev
```

You do not need a tunnel for the OAuth flow: GitHub redirects the _browser_ to
the callback, it never calls your server. A tunnel is only needed to receive
webhooks.

```bash
npm run check   # lint + type-check
```

[TESTING.md](./TESTING.md) is the runbook for proving it actually works by what has already been verified, what hasn't, and the order to test in.

## Design notes

**Where the credentials live.** The GitHub access and refresh tokens are stored in the OAuth grant's `props`, which `@cloudflare/workers-oauth-provider` encrypts using the issued MCP token as key material. D1 holds tenant records, connection history and usage counters, and deliberately holds no credentials at all.

**Why refresh only happens in `tokenExchangeCallback`.** Using a GitHub refresh
token invalidates the previous pair, and an API request has no way to write
`props` back. Refreshing lazily on a 401 would therefore spend the refresh token,
use the replacement once, and throw it away, bricking the grant. Instead the MCP
access token is given a 1-hour TTL, comfortably shorter than GitHub's 8 hours, so
the MCP token always expires first and every refresh flows through the one place
that can persist the result.

**Installation tokens** are cached in KV per installation. The app-JWT endpoints
share a single 5,000/hour budget across every tenant, so minting per request
would make that budget the ceiling for the whole service.

**Metering** counts tool calls per installation per month, deferred through
`waitUntil` so it never sits in the latency path, and enforced before any GitHub
request happens. There is no billing integration: `DEFAULT_MONTHLY_QUOTA` and
the `quotas` table are the seam one would attach to.

**Rate limits** differ by identity, which is worth knowing when choosing
`act_as`: an installation gets its own 5,000–12,500/hour, while a user's 5,000
per hour is shared across every GitHub App acting on their behalf.

**No `Contents` permission.** Merging a PR and creating a branch both need
`Contents: write`, so neither is offered. The server opens and annotates pull
requests; it never writes code or merges anything. That is a deliberate ceiling
on what a tenant is agreeing to when they install the App.

**Changing permissions is not retroactive.** If you add a repository permission
after people have installed the App, every existing installation keeps the old
permission set until its owner approves the update — tokens do not silently gain
the new access. The 403 you get in the meantime is explained as such by the tool
layer rather than passed through raw.

**Known limitation.** App bot accounts cannot be issue assignees. Assigning a
person works under either `act_as`; assigning the bot itself is not possible at
all, and the 422 you get back says so.
