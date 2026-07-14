-- =====================================================================
-- Per-router event log — drives the device page's "Device Events" tab.
-- Records lifecycle events (created/provisioned/reprovisioned/configured/
-- backup/error) written by the routers service, plus online/offline
-- transitions detected by the WG handshake heartbeat.
--
-- routers.wg_online holds the LAST reported liveness so the heartbeat can
-- log a transition only when the state actually flips (dedup): NULL = never
-- evaluated, so the first evaluation always logs the current state.
-- =====================================================================

CREATE TABLE IF NOT EXISTS router_event (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id  UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,          -- online|offline|created|provisioned|reprovisioned|configured|backup|error
  detail     TEXT,
  actor      TEXT,                   -- operator username when human-initiated; NULL for system
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS router_event_router
  ON router_event (router_id, created_at DESC);

ALTER TABLE routers ADD COLUMN IF NOT EXISTS wg_online BOOLEAN;
