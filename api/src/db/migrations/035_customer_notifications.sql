-- =====================================================================
-- customer_notifications_log: dedup channel for transactional SMS.
--
-- Some notifications (low-balance, expiry warning) fire from periodic
-- sweeps and would re-send every tick without state. This table holds
-- (customer_id, kind, dedup_key) so the helper can `INSERT ... ON
-- CONFLICT DO NOTHING` and naturally skip duplicates.
--
-- dedup_key is constructed per scenario, typically `<service_id>:<bucket>`
-- where bucket is a daily marker like '2026-06-05' so a low-balance
-- warning fires at most once per customer per service per day.
--
-- Append-only beyond status updates; never DELETE — the table doubles
-- as an audit of what we've told each customer (alongside audit_log
-- which captures operator actions but not outbound comms).
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_notifications_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'sms',
  dedup_key     TEXT NOT NULL,
  to_address    TEXT NOT NULL,    -- phone number for sms, email for email
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_notifications_dedup
  ON customer_notifications_log (customer_id, kind, dedup_key);
CREATE INDEX IF NOT EXISTS customer_notifications_recent
  ON customer_notifications_log (customer_id, created_at DESC);
