-- =====================================================================
-- RouterOS config backups — drives the device page's "Backups" tab.
-- Each row is a text `/export` snapshot captured over the WireGuard tunnel
-- (SSH). Kept in the tenant's own DB so an operator can review/download a
-- known-good config and diff against the live router. content is the raw
-- export; size_bytes is its byte length for the list view.
-- =====================================================================

CREATE TABLE IF NOT EXISTS router_backup (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id  UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'export',
  content    TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS router_backup_router
  ON router_backup (router_id, created_at DESC);
