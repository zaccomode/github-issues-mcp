-- Tenant records, connection history, and usage counters.
--
-- Deliberately holds no credentials. The GitHub access and refresh tokens live
-- in the OAuth grant's `props`, encrypted by @cloudflare/workers-oauth-provider
-- with the issued MCP token as key material. Mirroring them here would trade
-- that property away, so no column in this file ever holds a token.

CREATE TABLE installations (
	id                   INTEGER PRIMARY KEY,   -- GitHub's installation id
	account_id           INTEGER NOT NULL,
	account_login        TEXT    NOT NULL,
	account_type         TEXT    NOT NULL,      -- 'User' | 'Organization'
	repository_selection TEXT    NOT NULL,      -- 'all' | 'selected'
	status               TEXT    NOT NULL DEFAULT 'active',  -- active|suspended|deleted
	created_at           INTEGER NOT NULL,
	updated_at           INTEGER NOT NULL,
	last_seen_at         INTEGER
);
CREATE INDEX idx_installations_account ON installations(account_login);
CREATE INDEX idx_installations_status ON installations(status);

CREATE TABLE users (
	id         INTEGER PRIMARY KEY,             -- GitHub's user id
	login      TEXT    NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_users_login ON users(login);

-- One row per (human, tenant, MCP client). Lets a user see and revoke the
-- connectors they have attached without exposing anything sensitive.
CREATE TABLE connections (
	user_id         INTEGER NOT NULL REFERENCES users(id),
	installation_id INTEGER NOT NULL REFERENCES installations(id),
	client_id       TEXT    NOT NULL,
	client_name     TEXT,
	first_seen_at   INTEGER NOT NULL,
	last_seen_at    INTEGER NOT NULL,
	revoked_at      INTEGER,
	PRIMARY KEY (user_id, installation_id, client_id)
);
CREATE INDEX idx_connections_installation ON connections(installation_id);

CREATE TABLE usage_counters (
	installation_id INTEGER NOT NULL,
	period          TEXT    NOT NULL,   -- 'YYYY-MM'
	kind            TEXT    NOT NULL,   -- 'tool_call' | 'github_request'
	count           INTEGER NOT NULL DEFAULT 0,
	updated_at      INTEGER NOT NULL,
	PRIMARY KEY (installation_id, period, kind)
);
CREATE INDEX idx_usage_period ON usage_counters(period);

-- Absent row means "use DEFAULT_MONTHLY_QUOTA"; a NULL monthly_limit means
-- unlimited. This is the seam billing would later attach to.
CREATE TABLE quotas (
	installation_id INTEGER PRIMARY KEY REFERENCES installations(id),
	plan            TEXT    NOT NULL DEFAULT 'free',
	monthly_limit   INTEGER,
	notes           TEXT,
	updated_at      INTEGER NOT NULL
);
