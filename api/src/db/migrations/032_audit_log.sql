-- =====================================================================
-- audit_log: who-did-what across the system. Captured at the service
-- layer (via logAudit calls in customer + service + portal mutations),
-- not via DB triggers — the actor context (admin username, customer id,
-- system worker) is application state that triggers can't see.
--
-- before / after are JSONB snapshots of the affected row. For creates,
-- before is null; for deletes, after is null. metadata carries extra
-- context like the route, the body fields supplied, or the reason.
--
-- Indexed for the two query shapes the operator UI uses:
--   - "show me activity on customer X" (entity + entity_id + created_at)
--   - "show me everything by actor Y in the last week" (actor + created_at)
-- =====================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Verb. Free-form so adding a new audited action doesn't need a migration,
  -- but the UI groups by these so use a stable vocabulary:
  --   customer.create | customer.update | customer.delete
  --   service.create  | service.status_change | service.renew
  --   service.plan_change | service.delete | service.expire
  --   bulk.import | payment.success | payment.failed
  kind         TEXT NOT NULL,
  -- The thing acted upon. entity_type='customer', entity_id=<uuid>.
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  -- Who did it. For staff, actor_label is their username; for customers
  -- self-serving via /portal, it's the customer's id (we already trust
  -- the customer role). For automated workers / cron, 'system'.
  actor_id     TEXT NOT NULL,
  actor_label  TEXT NOT NULL,
  actor_role   TEXT NOT NULL,
  before       JSONB,
  after        JSONB,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor  ON audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_kind   ON audit_log (kind, created_at DESC);
