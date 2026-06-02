-- =====================================================================
-- Generic key/value settings table. First use: M-Pesa Daraja credentials
-- so the admin can configure them in the dashboard instead of going to
-- Render's env-var UI. Secrets stay in Postgres; env vars remain a
-- fallback for bootstrap.
-- =====================================================================

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  is_secret  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
