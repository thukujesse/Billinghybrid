-- =====================================================================
-- Router template-sync tracking — observability for the captive HTML
-- + walled-garden push pipeline.
--
-- Every time we push hotspot templates to a router (auto-triggered by
-- branding changes / provision / reprovision, or admin "Sync now"),
-- we record the result here so the routers page can show a status
-- badge per router and operators can spot stale or failing routers
-- at a glance.
--
-- template_sync_version is a short hash that captures "the template
-- content the router currently has". When the bundle of template
-- bytes + walled-garden host/IP + brand slug differs from what was
-- last pushed, the router shows "stale" until next sync.
-- =====================================================================

ALTER TABLE routers
  ADD COLUMN IF NOT EXISTS last_template_sync_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_template_sync_status  TEXT,
  ADD COLUMN IF NOT EXISTS last_template_sync_error   TEXT,
  ADD COLUMN IF NOT EXISTS template_sync_version      TEXT;

-- Status values, soft-enforced at the application layer:
--   'ok'      — last push succeeded; templates known fresh
--   'failed'  — last push errored (SSH unreachable, fetch failed, etc.)
--   'pending' — admin triggered a re-sync that hasn't completed yet
--   NULL      — never synced (newly added router that hasn't been
--               configured yet, or pre-migration routers)
DO $$ BEGIN
  ALTER TABLE routers
    ADD CONSTRAINT routers_template_sync_status_chk
    CHECK (last_template_sync_status IN ('ok','failed','pending') OR last_template_sync_status IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
