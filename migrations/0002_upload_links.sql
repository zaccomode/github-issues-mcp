-- Single-use links for uploading a release asset; see src/uploads/links.ts.
--
-- Kept in D1 rather than KV because claiming a link has to be atomic: an
-- `UPDATE … WHERE used_at IS NULL` lets exactly one request through, which
-- KV's eventual consistency cannot promise.
--
-- The link itself is never stored, only its SHA-256. For a link made with
-- act_as "user", `sealed_token` holds the person's GitHub token encrypted with
-- a key derived from the link, so it is unreadable without the link and this
-- table still holds nothing usable as a credential.

CREATE TABLE upload_links (
	id              TEXT    PRIMARY KEY,   -- hex SHA-256 of the link's secret
	installation_id INTEGER NOT NULL,
	account_login   TEXT    NOT NULL,
	actor           TEXT    NOT NULL,      -- 'app' | 'user'
	user_login      TEXT    NOT NULL,      -- who made the link
	sealed_token    TEXT,                  -- only when actor = 'user'
	owner           TEXT    NOT NULL,
	repo            TEXT    NOT NULL,
	release_id      INTEGER NOT NULL,
	name            TEXT    NOT NULL,
	label           TEXT,
	content_type    TEXT    NOT NULL,
	created_at      INTEGER NOT NULL,
	expires_at      INTEGER NOT NULL,
	used_at         INTEGER
);
CREATE INDEX idx_upload_links_expires ON upload_links(expires_at);
