-- =====================================================================
-- Router registry (Network Integration Layer): centralizes the fleet of
-- Mikrotik/RADIUS devices so provisioning can target the right box and
-- the system supports multi-router deployments.
-- =====================================================================

CREATE TABLE routers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  host       TEXT NOT NULL,
  api_port   INTEGER NOT NULL DEFAULT 8728,
  username   TEXT,
  password   TEXT,
  type       TEXT NOT NULL DEFAULT 'mikrotik' CHECK (type IN ('mikrotik','radius')),
  site       TEXT,
  status     TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','offline','degraded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which router a subscriber's service lives on.
ALTER TABLE subscribers
  ADD COLUMN router_id UUID REFERENCES routers(id) ON DELETE SET NULL;
