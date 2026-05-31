-- =====================================================================
-- One-liner provisioning: each router gets an opaque URL-safe token that
-- the MikroTik `/tool fetch` URL embeds. The token is single-use (becomes
-- consumed on first download) and expires 24h after creation if unused.
-- =====================================================================

ALTER TABLE routers
  ADD COLUMN provision_token            TEXT,
  ADD COLUMN provision_token_expires_at TIMESTAMPTZ,
  ADD COLUMN provision_token_used_at    TIMESTAMPTZ;

CREATE UNIQUE INDEX routers_provision_token_uniq
  ON routers (provision_token)
  WHERE provision_token IS NOT NULL;
