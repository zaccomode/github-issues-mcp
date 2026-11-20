# github-utilities-mcp

A remote, Cloudflare Workers-based MCP server to manage GitHub issues, releases, PRs, security scans and more, deployed as a GitHub app so that an agent's changes are attributable.

This MCP server exists because the official GitHub MCP server must be run locally to connect to Claude Desktop, thus preventing it from properly working with Claude's cloud agent environment. This works anywhere an MCP server is accepted, without all the fiddling the official one currently requires. 

The MCP server also supports app attribution, allowing the work an agent does autonomously to be attributed to someone other than you. It makes you look slightly less insane than replying to yourself in conversations, and gives you a clear blame path for issues.

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

Releases: `list_releases`, `get_release`, `list_release_assets`, `list_tags`,
`compare_refs`, `generate_release_notes`, `create_release`, `update_release`,
`publish_release`, `promote_release`, `unpublish_release`, `delete_release`,
`create_release_asset_upload`, `upload_release_asset`, `update_release_asset`,
`delete_release_asset`.

The write tools accept `act_as`. Reads always run as the signed-in person,
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

### Releases

The release tools read releases, draft notes, create, publish, unpublish and
delete releases, and manage the files attached to them.

- **Drafts first.** `create_release` only creates drafts, which notify nobody and
  start no workflows. `generate_release_notes` has GitHub write notes from the
  pull requests merged since the last release without saving anything, and
  `compare_refs` lists the commits between two refs for writing notes by hand.
- **Publishing takes two calls.** `publish_release` without `confirm` publishes
  nothing: it checks the release is ready, resolves the commit it would tag,
  lists the workflows in `.github/workflows/` whose `on: release` (and its
  `types:` filter, if any) matches what publishing sends, and returns
  a `confirm_token`. If the tag doesn't exist yet, publishing creates it, so the
  preview also lists the `create` workflows and `push` workflows that run on
  tags, under `triggered_by_tag_creation`. A draft whose tag is GitHub's
  `untagged-…` placeholder is refused. Calling it again with `confirm: true` and that token
  publishes, with the tag pinned to the previewed commit. If the release, its
  target or the branch head changed in between, the token no longer matches and
  nothing is published. The token also covers whether the tag existed and which
  workflows were listed. This matters because a release published with an
  App's token starts workflows, unlike one published with Actions' own
  `GITHUB_TOKEN`, so publishing can deploy or push a package.
- **Workflow previews fail safe.** A workflow file that can't be read or parsed
  (invalid YAML, or one past the parser's alias limit) is listed under
  `unanalysed` as possibly starting, never dropped, and is bound into the
  token. Workflows with `on: workflow_run` that name a listed workflow, directly
  or through a chain of up to three, are listed under
  `triggered_by_workflow_run`. GitHub reads `workflow_run` workflows from the
  default branch rather than the tagged commit, so that list is an
  approximation and the preview says so. Workflow names, paths and the release
  title come from contributors, so both tools mark them in `untrusted_fields`.
- **Promoting a prerelease takes two calls too.** Turning a published
  prerelease into a full release sends `release: released`, which starts
  deploys like this repository's own. `update_release` refuses that change;
  `promote_release` previews the workflows it starts and then confirms with a
  token, the same way `publish_release` does.
- **Unpublishing only hides.** `unpublish_release` turns a release back into a
  draft, but notifications already sent and workflows already started stay done.
  Repositories with immutable releases turned on lock a release once it is
  published, so it can't be unpublished.
- **Tags are never deleted.** `delete_release` removes drafts, or published
  releases with `allow_published: true`, and leaves the tag in place.
- **Tags must be explicit.** If a tag doesn't exist yet, `create_release` and
  `update_release` need `target_commitish`; otherwise GitHub would tag whatever
  the default branch points at. On a draft, `update_release` always sends the
  current tag back, because GitHub otherwise resets a draft's not-yet-created
  tag to an `untagged-…` placeholder.
- **Published releases need `allow_published`.** `update_release` changes drafts
  only, unless given `allow_published: true`. On a published release, a new
  `tag_name` creates that tag at once, and any edit starts `release: edited`
  workflows.
- **Asset changes follow the same rules.** `update_release_asset` (rename or
  relabel) and `delete_release_asset` work on drafts, or on published releases
  with `allow_published: true`. Published immutable releases can't be changed.

#### Uploading assets

Files don't travel inside the tool call. `create_release_asset_upload` returns a
single-use link on this server that expires after 15 minutes, plus a ready-made
`curl` command. The agent sends the file from its shell, and the server streams
it on to GitHub as the chosen `act_as` identity, without buffering it:

```bash
curl -sS --fail-with-body --upload-file ./dist/app.zip \
  -H "Authorization: Bearer $UPLOAD_SECRET" \
  -H 'Content-Type: application/zip' "$UPLOAD_URL"
```

The URL names the link; the secret in the `Authorization` header is what
lets the upload through, so a URL seen in a log can't be replayed.

- **One file per link, up to 100 MB,** which is Cloudflare's request body limit
  on the Free and Pro plans. Larger files need a Business or Enterprise zone.
- **The agent's machine has to reach this server.** MCP calls go through the
  client, but the upload goes straight from the agent's shell. In sandboxed
  environments such as Claude's cloud sessions, add this server's host (for the
  public App, `github-issues-mcp.zaccomode.workers.dev`) to the environment's
  allowed network hosts.
- **No shell?** `upload_release_asset` takes the content directly, as text or
  base64, up to 256 KB. It's meant for checksums, SBOMs and changelogs.
- **No fetching from URLs.** That would let any caller make the server request
  any address it likes.

These tools need the App's Contents permission (see below). GitHub also refuses
to point a release at a commit that changes files in `.github/workflows/`
unless the token holds the Workflows permission, which this App doesn't ask for.

## Setting it up

### 1. Register a GitHub App

<https://github.com/settings/apps/new>

| Setting                                                | Value                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Callback URL                                           | `https://<your-host>/callback`                                                                                 |
| Request user authorization (OAuth) during installation | **on**                                                                                                         |
| Expire user authorization tokens                       | **on**                                                                                                         |
| Setup URL                                              | leave blank                                                                                                    |
| Webhook URL                                            | `https://<your-host>/webhooks/github`                                                                          |
| Repository permissions                                 | Issues: **read & write**; Pull requests: **read & write**; Contents: **read & write**; Metadata: **read-only** |
| Where can this be installed                            | **Any account**                                                                                                |

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

`npm run deploy` applies any pending migrations before it deploys, so a new
migration never lands after the code that needs it.

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

After that, publishing a release deploys. Bump `version` in `package.json` on
`main`, then publish a release tagged `v<version>` (e.g. `v2.3.0`) from `main`,
by hand or with `publish_release`. The Deploy workflow checks the tag is on
`main` and matches `package.json`, runs the same checks as CI, then runs
`npm run deploy`. Pre-releases don't deploy until they are promoted to a full release. To redeploy an older release, run
the Deploy workflow by hand from its tag; migrations don't roll back, so only
when that code works with the newer schema.

The workflow needs a GitHub environment named `production`, with deployment
tags limited to `v*`, holding two secrets: `CLOUDFLARE_ACCOUNT_ID`, and
`CLOUDFLARE_API_TOKEN` with Workers Scripts, Workers KV Storage and D1 edit on
the account.

The tag-on-`main` and version checks are read from `deploy.yml` at the tagged
commit, so anyone who can push a `v*` tag could tag a branch whose workflow
skips them. Close that gap with one of:

- a tag ruleset (Settings → Rules → Rulesets, target tags matching `v*`) that
  restricts creating, updating and deleting them to repository admins; or
- a required reviewer on the `production` environment, so every deploy waits
  for approval.

The checks and tests run in a job with no secrets. The deploy job installs with
`npm ci --ignore-scripts`, so a dependency's install script never runs beside
`CLOUDFLARE_API_TOKEN`.

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
npm test        # unit tests, in the Workers runtime with a local D1
```

CI runs both on every pull request.

## Design notes

**Where the credentials live.** The GitHub access and refresh tokens are stored in the OAuth grant's `props`, which `@cloudflare/workers-oauth-provider` encrypts using the issued MCP token as key material. D1 holds tenant records, connection history and usage counters, and deliberately holds no credentials at all.

**Upload links** are stored in D1 rather than KV, because only D1's `UPDATE … WHERE used_at IS NULL` can stop a link being used twice. Only the link's SHA-256 is stored. The link's secret is sent in the upload's `Authorization: Bearer` header; the URL carries only its SHA-256, so the request URLs Workers Logs records can't be replayed. A link made with `act_as: "user"` has to carry the person's token until the file arrives, so the token is encrypted with a key derived from both the secret and the Worker's `GITHUB_CLIENT_SECRET`: neither the row nor the URL can be turned back into a credential. The sealed token is cleared the moment the link is claimed, and from any link that expires unused. Each link also records the OAuth grant that made it, and the upload is refused if that grant has been revoked since.

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

**Contents permission, but no tool that writes code.** The release tools need
`Contents: read & write`, because GitHub has no narrower permission for
releases and their assets. The same permission would let a token push commits,
create branches and merge pull requests, so installing the App grants that much. No tool here
does any of those things: the server opens and annotates pull requests and
manages releases, and never writes code, merges or deletes tags.

**Changing permissions is not retroactive.** If you add a repository permission
after people have installed the App, every existing installation keeps the old
permission set until its owner approves the update — tokens do not silently gain
the new access. The 403 you get in the meantime is explained as such by the tool
layer rather than passed through raw.

**Known limitation.** App bot accounts cannot be issue assignees. Assigning a
person works under either `act_as`; assigning the bot itself is not possible at
all, and the 422 you get back says so.
