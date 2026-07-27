# Testing this server

Setup instructions live in [README.md](./README.md). This file is the runbook
for *proving it works* — what has already been verified, what hasn't, and the
order to do things in.

## What is already verified

Checked locally, without any GitHub App:

- The worker boots; `/`, `/healthz` respond and `POST /mcp` 401s unauthenticated.
- `.well-known/oauth-authorization-server` and `.well-known/oauth-protected-resource`
  advertise the right endpoints.
- Dynamic client registration → consent page naming the client and showing its
  redirect URIs → 302 to GitHub with `redirect_uri` built from `PUBLIC_URL`.
- OAuth `state` is single-use: a replayed callback URL is rejected.
- A callback with `setup_action=install` and no state renders the "Installed"
  page rather than erroring.
- Webhooks: a bad signature is rejected 401; a valid one flips the
  `installations` row to `deleted` in D1.
- The RS256 App JWT signer produces a signature that verifies against the
  public key, with `iat` backdated and `exp` inside GitHub's 10-minute cap;
  it memoises; it accepts a PEM with literal `\n` escapes; and it rejects a
  PKCS#1 key with the `openssl` fix in the error message.
- The SSRF guard in `src/github/client.ts` blocks `//evil.com/x`,
  `https://evil.com/x`, `relative/path` and `\\evil.com/x` before any fetch.
- `explain()` produces the actor-aware hints, and `scrub()` redacts
  token-shaped strings.

## What is NOT verified

**Every code path that calls api.github.com.** Specifically:

- minting an installation access token (`src/auth/installation.ts`)
- the OAuth code exchange and `GET /user/installations`
  (`src/auth/user-oauth.ts`)
- the callback flow end to end (`src/auth/handler.ts`)
- `whoami`
- **whether `act_as: "app"` actually produces a `[bot]`-authored issue** — the
  entire point of the redesign

None of it can be exercised without a real GitHub App. If something is broken,
those three modules are the likely suspects.

---

## Path A — smoke test, no GitHub App (~2 min)

Proves the build and the security properties. Proves nothing about GitHub.

```bash
npm install

# Any well-formed PKCS#8 key works; nothing reaches GitHub on this path.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out dev.pkcs8.pem
cp .dev.vars.example .dev.vars   # then paste the key in, or:
#   GITHUB_APP_PRIVATE_KEY="$(awk '{printf "%s\\n", $0}' dev.pkcs8.pem)"

npm run db:migrate:local
npx wrangler dev --port 8787 \
  --var GITHUB_APP_ID:123456 \
  --var GITHUB_APP_SLUG:dev-issues-app \
  --var GITHUB_CLIENT_ID:Iv23liDEVCLIENT \
  --var PUBLIC_URL:http://localhost:8787
```

Then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/healthz    # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/mcp # 401
curl -s http://localhost:8787/.well-known/oauth-authorization-server | jq
```

> The `PLACEHOLDER_…` binding ids in `wrangler.jsonc` **do not matter locally** —
> local KV and D1 are simulated by binding name. Real ids are only needed to
> deploy.

---

## Path B — the real test (~20 min)

### B1. Register a dev GitHub App

<https://github.com/settings/apps/new>

| Setting | Value |
| --- | --- |
| Name | anything, e.g. `zac-issues-dev` |
| Homepage URL | `http://localhost:8787` |
| Callback URL | `http://localhost:8787/callback` |
| Request user authorization (OAuth) during installation | **on** |
| Expire user authorization tokens | **on** |
| Setup URL | leave blank |
| Webhook | **uncheck Active** — needs a tunnel, not required for this test |
| Repository permissions | Issues **read & write**, Metadata **read-only**, Pull requests read-only |
| Where can this be installed | Only on this account |

Use a **separate dev App** rather than repointing a production one — it keeps
the production private key off your machine.

Afterwards, from the App's settings page collect:

- **App ID**
- **Client ID**
- the **slug** (the last path segment of the App's public URL)
- a generated **client secret**
- a generated **private key** (downloads as PKCS#1)

Then **install the App on one scratch repo**.

Convert the key — WebCrypto cannot import PKCS#1:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in ~/Downloads/zac-issues-dev.*.private-key.pem -out dev.pkcs8.pem
```

### B2. Wire it up

`.dev.vars`:

```
GITHUB_CLIENT_SECRET="..."
GITHUB_WEBHOOK_SECRET="anything-for-local"
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Then run `wrangler dev` as in Path A, substituting the real App ID, slug and
client ID.

### B3. Connect a client

```bash
npx @modelcontextprotocol/inspector
```

Point it at `http://localhost:8787/mcp`. The Inspector walks the whole OAuth
dance visibly, which is what you want the first time. Claude Code or a Claude
Desktop connector work too once it's proven out.

**No tunnel needed.** GitHub redirects your *browser* to the callback; it never
calls your server. A tunnel is only required to receive webhooks.

### B4. The tests that matter

Run these in order — each one proves a different thing.

1. **`whoami`** → should return both identities and a plausible
   `repositories_accessible`. *First real proof the App JWT → installation token
   path works.*
2. **`create_issue`** on the scratch repo, no `act_as` → open it in GitHub.
   Should be authored by `your-app[bot]`. *This is the redesign's whole thesis.*
3. **`create_issue` with `act_as: "user"`** → authored by you, with an app badge.
4. **`create_issue` with `assignees: ["your-app[bot]"]`** → expect the
   *explained* 422 saying bots cannot be assignees, not a raw GitHub error.
5. **Isolation.** Pick a repo you can see but the App is **not** installed on.
   `get_issue` should succeed (runs as you); `add_issue_comment` should 404 with
   the "app not installed there" explanation.

Test 5 is the one worth not skipping — it is what proves the tenant boundary is
real rather than merely intended.

### B5. Optional negative tests

- Hand-edit `installation_id` on the callback URL to a foreign number → must be
  ignored, not honoured.
- Replay a callback URL → must be rejected.
- Uninstall the App → the next `act_as: "app"` call should fail with the
  "connection removed" message rather than a 500.
- Set `DEFAULT_MONTHLY_QUOTA=3` and make 4 calls → the 4th refused *before* any
  GitHub request goes out.
- Inspect D1 and confirm no column anywhere holds a token:
  ```bash
  npx wrangler d1 execute github-issues-mcp --local \
    --command "select * from installations; select * from connections;"
  ```

### B6. Token refresh

The MCP access token has a 1-hour TTL against GitHub's 8 hours, so refresh is
hard to observe naturally. To force it, temporarily set `ACCESS_TOKEN_TTL` in
`src/index.ts` to `120`, idle past it, and make a call: the client should
refresh transparently and keep working. Put it back afterwards.

---

## Path C — deploy

See [README.md](./README.md#setting-it-up). In short: create the real KV and D1
bindings, replace the two `PLACEHOLDER_…` ids in `wrangler.jsonc`, set
`PUBLIC_URL` to the worker URL, `npm run cf-typegen && npm run db:migrate`, put
the three secrets, deploy.

Register a **second, production** GitHub App whose callback and webhook point at
the deployed host, mark it installable by **any account**, and turn the webhook
on. Then re-run the Path B tests against the deployed URL — particularly the
webhook, which the local run skips.
