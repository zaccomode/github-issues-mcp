# github-issues-mcp

A remote MCP server for GitHub issues, built as a **GitHub App** so that an
agent's changes are attributable.

Every write tool takes an `act_as` argument:

- `act_as: "app"` (the default) posts as the App's bot account, so a comment an
  agent left reads as `your-app[bot]` and is obviously not you.
- `act_as: "user"` posts as the person who authorised the connection, badged as
  coming via the App.

That distinction is the point of the server. It also means no personal access
token is involved anywhere, and that anyone can connect their own GitHub account
without you editing a config file.

## Tools

`whoami`, `list_issues`, `get_issue`, `search_issues`, `create_issue`,
`update_issue`, `list_issue_comments`, `add_issue_comment`,
`update_issue_comment`, `list_labels`, `add_issue_labels`, `remove_issue_label`.

The six write tools accept `act_as`. Reads always run as the signed-in person, so
what an agent can see matches what you can see — which does mean `search_issues`
can surface issues in repositories the write tools cannot touch. `whoami` reports
both identities and where the App is actually installed.

## How a connection is made

1. An MCP client discovers `/authorize` and shows a consent screen naming itself.
2. The browser goes to GitHub for the user-to-server OAuth handshake.
3. We list the App installations that user can actually reach. If there are
   none, they are sent to install it; if there are several, they pick one.
4. The grant is bound to exactly one installation. Nothing a tool can pass
   changes which installation its writes go to.

GitHub puts an `installation_id` on the post-install redirect, but it is
forgeable, so it is only ever used as a hint and cross-checked against
`GET /user/installations` for the token just minted.

## Setting it up

### 1. Register a GitHub App

<https://github.com/settings/apps/new>

| Setting | Value |
| --- | --- |
| Callback URL | `https://<your-host>/callback` |
| Request user authorization (OAuth) during installation | **on** |
| Expire user authorization tokens | **on** |
| Setup URL | leave blank |
| Webhook URL | `https://<your-host>/webhooks/github` |
| Repository permissions | Issues: **read & write**; Metadata: **read-only**; Pull requests: read-only |
| Where can this be installed | **Any account** |

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

You do not need a tunnel for the OAuth flow: GitHub redirects the *browser* to
the callback, it never calls your server. A tunnel is only needed to receive
webhooks.

```bash
npm run check   # lint + type-check
```

[TESTING.md](./TESTING.md) is the runbook for proving it actually works —
what has already been verified, what hasn't, and the order to test in.

## Design notes

**Where the credentials live.** The GitHub access and refresh tokens are stored
in the OAuth grant's `props`, which `@cloudflare/workers-oauth-provider` encrypts
using the issued MCP token as key material — they cannot be recovered from KV
without a live token. D1 holds tenant records, connection history and usage
counters, and deliberately holds no credentials at all.

**Why refresh only happens in `tokenExchangeCallback`.** Using a GitHub refresh
token invalidates the previous pair, and an API request has no way to write
`props` back. Refreshing lazily on a 401 would therefore spend the refresh token,
use the replacement once, and throw it away — bricking the grant. Instead the MCP
access token is given a 1-hour TTL, comfortably shorter than GitHub's 8 hours, so
the MCP token always expires first and every refresh flows through the one place
that can persist the result.

**Installation tokens** are cached in KV per installation. The app-JWT endpoints
share a single 5,000/hour budget across every tenant, so minting per request
would make that budget the ceiling for the whole service.

**Metering** counts tool calls per installation per month, deferred through
`waitUntil` so it never sits in the latency path, and enforced before any GitHub
request happens. There is no billing integration — `DEFAULT_MONTHLY_QUOTA` and
the `quotas` table are the seam one would attach to.

**Rate limits** differ by identity, which is worth knowing when choosing
`act_as`: an installation gets its own 5,000–12,500/hour, while a user's 5,000
per hour is shared across every GitHub App acting on their behalf.

**Known limitation.** App bot accounts cannot be issue assignees. Assigning a
person works under either `act_as`; assigning the bot itself is not possible at
all, and the 422 you get back says so.
