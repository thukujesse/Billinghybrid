-- =====================================================================
-- Track the proactive "your plan expires tomorrow" SMS so the hourly
-- worker doesn't re-send to the same customer every tick. Cleared on
-- renewService() so the warning fires again next cycle.
-- =====================================================================
ALTER TABLE services ADD COLUMN IF NOT EXISTS expiry_warned_at TIMESTAMPTZ;

-- Partial index for the warning sweep: finds services whose expiry is
-- inside the warning window AND haven't been warned yet.
CREATE INDEX IF NOT EXISTS services_warn_due
  ON services (expiry_date)
  WHERE status = 'active' AND expiry_warned_at IS NULL AND expiry_date IS NOT NULL;