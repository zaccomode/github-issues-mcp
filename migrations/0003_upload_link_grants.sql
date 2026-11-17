-- Ties each upload link to the OAuth grant that made it, so the upload handler
-- can refuse a link whose grant has since been revoked; see src/uploads/links.ts.
--
-- Links made before this migration have neither column. They are refused,
-- since nothing says which grant they belong to; they expire within fifteen
-- minutes of being made anyway.

ALTER TABLE upload_links ADD COLUMN grant_user_id TEXT;
ALTER TABLE upload_links ADD COLUMN grant_id TEXT;
