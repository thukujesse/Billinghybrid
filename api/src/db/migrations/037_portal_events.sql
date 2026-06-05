-- =====================================================================
-- Captive-portal event log — operator-facing diagnostics.
--
-- Append-only chronological trace of what happened to a device on the
-- captive portal. Complements auto_reconnect_log (which only tracks the
-- silent auto-grant tiers) with EVERY other touchpoint:
--   portal_load, quick_connect, voucher_redeem, stk_init, stk_callback,
--   rebind_start, rebind_verify, grant_issued, token_mint, token_revoke
--
-- When a customer rings the help line and says "I paid but no internet",
-- the operator pastes the MAC into /diagnostics and reads the timeline
-- end-to-end: STK push fired? Daraja callback succeeded? Grant written?
-- Auto-grant tier reached? RADIUS accepted? — every step is one row.
--
-- detail JSONB carries event-specific context (checkoutRequestId, plan
-- name, voucher prefix, mtik error string, etc.) without schema churn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS portal_events (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type  TEXT NOT NULL,
  -- nullable: portal_load events arrive before we know the phone; grant
  -- events arrive before we always know the router_id.
  mac         TEXT,
  phone       TEXT,
  router_id   UUID REFERENCES routers(id) ON DELETE SET NULL,
  tenant      TEXT,
  -- success=NULL for informational events (portal_load), TRUE/FALSE
  -- for events with a clear outcome (voucher_redeem, stk_init, ...).
  success     BOOLEAN,
  reason      TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_ip   TEXT,
  user_agent  TEXT
);

-- Diagnostics is mostly "give me everything for this MAC newest-first".
CREATE INDEX IF NOT EXISTS portal_events_mac_idx     ON portal_events (mac, created_at DESC) WHERE mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS portal_events_phone_idx   ON portal_events (phone, created_at DESC) WHERE phone IS NOT NULL;
-- For dashboards: count of event_type X in last N minutes.
CREATE INDEX IF NOT EXISTS portal_events_type_time_idx ON portal_events (event_type, created_at DESC);
-- Generic time scan for "show me the last N events globally".
CREATE INDEX IF NOT EXISTS portal_events_created_idx   ON portal_events (created_at DESC);
