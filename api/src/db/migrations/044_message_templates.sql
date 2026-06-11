-- =====================================================================
-- Editable customer-message templates, with separate wording for hotspot vs
-- PPPoE audiences. The DEFAULT text lives in code (domains/messageTemplates) —
-- this table only holds OVERRIDES, so a fresh install behaves exactly as before
-- until an operator edits a template. enabled=false suppresses the send.
-- Per-tenant via DB-per-tenant.
-- =====================================================================

CREATE TABLE message_templates (
  event_key  TEXT NOT NULL,
  audience   TEXT NOT NULL CHECK (audience IN ('hotspot', 'pppoe', 'all')),
  body       TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  PRIMARY KEY (event_key, audience)
);
