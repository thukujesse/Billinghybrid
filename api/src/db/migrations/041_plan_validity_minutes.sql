-- =====================================================================
-- Sub-day package durations. validity_days is an INTEGER used by ~15 PPPoE
-- date-math consumers (setDate(getDate()+days)) that only work in whole days,
-- so we DON'T make it fractional. Instead add validity_minutes as the canonical
-- fine-grained duration (1h = 60, 1 day = 1440, 30 days = 43200). Hotspot grants
-- read validity_minutes; validity_days stays as a whole-day approximation for the
-- PPPoE/date consumers. Backfill keeps existing plans exactly equivalent.
-- =====================================================================

ALTER TABLE plans ADD COLUMN validity_minutes INTEGER
  CHECK (validity_minutes IS NULL OR validity_minutes > 0);

UPDATE plans SET validity_minutes = validity_days * 1440 WHERE validity_minutes IS NULL;
