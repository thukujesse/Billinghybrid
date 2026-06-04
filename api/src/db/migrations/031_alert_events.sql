-- =====================================================================
-- alert_events: operator-facing health alerts.
--
-- Each row is a single "incident" — opened when an evaluator first sees
-- a bad condition, fires a Telegram to the admin chat once at open, and
-- closes itself when the condition clears. dedup_key prevents minute-by-
-- minute re-alerting on a chronic condition.
--
-- Lifecycle:
--   open  → evaluator saw the condition, Telegram fired
--   acked → operator clicked Acknowledge in the dashboard (still open,
--           just suppresses future repeat alerts on the same dedup_key)
--   resolved → evaluator no longer sees the condition; closed_at set
--
-- Append-only beyond the lifecycle fields above; never DELETE — the
-- history table doubles as an audit log for ops post-mortems.
-- =====================================================================
CREATE TABLE IF NOT EXISTS alert_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN ('dlq_items','queue_backlog','router_offline','expire_sms_failed','radius_unreachable')),
  severity    TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  -- Stable identifier for the affected entity (e.g. router id, "global").
  -- (kind, dedup_key) is the uniqueness for an open alert: we never open
  -- a second alert with the same pair until the first is resolved.
  dedup_key   TEXT NOT NULL,
  message     TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','resolved')),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at    TIMESTAMPTZ,
  acked_by    TEXT,
  resolved_at TIMESTAMPTZ,
  -- Last time the evaluator confirmed the condition. Used so an alert
  -- that flaps between open and resolved doesn't lose its evidence.
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup: "is there an open alert for this kind+entity?" — the dedup
-- check the evaluator runs every tick. Partial so only open rows are
-- considered (resolved rows don't block re-opening).
CREATE UNIQUE INDEX IF NOT EXISTS alert_events_open_uniq
  ON alert_events (kind, dedup_key) WHERE status <> 'resolved';

-- History view: chronological by open time.
CREATE INDEX IF NOT EXISTS alert_events_opened ON alert_events (opened_at DESC);
