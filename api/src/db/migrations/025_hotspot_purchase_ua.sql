-- =====================================================================
-- Capture device user-agent at purchase time so admin Devices view can
-- show "iPhone 15 / iOS 17" alongside the phone number that paid.
-- Nullable for backfill — older rows just show "—" in the UI.
-- =====================================================================
ALTER TABLE hotspot_purchases ADD COLUMN IF NOT EXISTS user_agent TEXT;
