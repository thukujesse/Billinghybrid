-- =====================================================================
-- DLQ audit log: snapshot of a payment_event at the moment it died.
--
-- We keep the original payment_events row (status='dead') so admins can
-- retry it from the dashboard; this table is the append-only history of
-- WHY/WHEN each event hit the dead state. One row per move-to-dead;
-- never updated. Useful for "show me everything that died last week"
-- queries without scanning the live queue.
-- =====================================================================

CREATE TABLE payment_events_dlq_audit (
  id        BIGSERIAL PRIMARY KEY,
  event_id  UUID NOT NULL REFERENCES payment_events(id) ON DELETE CASCADE,
  moved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason    TEXT NOT NULL,
  -- Frozen copy of the payment_event row at time of death (source, dedup_key,
  -- payload, attempts, last_error). Decoupled from live row so an admin
  -- retry that mutates the original doesn't rewrite history.
  snapshot  JSONB NOT NULL
);

CREATE INDEX payment_events_dlq_audit_event ON payment_events_dlq_audit (event_id);
CREATE INDEX payment_events_dlq_audit_moved ON payment_events_dlq_audit (moved_at DESC);
