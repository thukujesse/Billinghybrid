-- =====================================================================
-- Link services to their plan. Drives rate_limit + expiry_date during
-- creation and renewal so the operator picks a package and everything
-- else (price/speed/validity) flows from it.
--
-- Nullable — legacy services that pre-date this column still work with
-- their stored rate_limit; new flows fill plan_id explicitly.
-- =====================================================================
ALTER TABLE services ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS services_plan ON services (plan_id) WHERE plan_id IS NOT NULL;

-- For the auto-expire scheduler: index lets the cron find soon-to-expire
-- rows in milliseconds even on a million-row services table.
CREATE INDEX IF NOT EXISTS services_expiry_active
  ON services (expiry_date)
  WHERE status = 'active' AND expiry_date IS NOT NULL;