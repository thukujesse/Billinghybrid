-- =====================================================================
-- Where each customer physically sits, plus how their service attaches to
-- the plant, plus the links the twin draws between nodes. A customer enters
-- the twin only when located (captured at install/survey, or set manually
-- on the map). One location per customer (their premises).
-- =====================================================================

CREATE TABLE customer_locations (
  customer_id   UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  latitude      DOUBLE PRECISION NOT NULL,
  longitude     DOUBLE PRECISION NOT NULL,
  accuracy_m    DOUBLE PRECISION,
  altitude_m    DOUBLE PRECISION,
  source        TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'install', 'survey', 'lead', 'geocode')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- How a service hangs off the plant. Filled at install, or by Phase-2
-- auto-mapping (nearest FAT/tower). Additive + nullable — no billing change.
ALTER TABLE services ADD COLUMN IF NOT EXISTS access_device_id UUID
  REFERENCES network_devices(id) ON DELETE SET NULL;
ALTER TABLE services ADD COLUMN IF NOT EXISTS onu_serial TEXT;

-- Physical links between nodes (fibre / backhaul / drop), drawn as polylines.
-- path_json is an optional [[lat,lng],...] route; absent = straight line.
CREATE TABLE network_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id      UUID NOT NULL REFERENCES network_devices(id) ON DELETE CASCADE,
  to_id        UUID NOT NULL REFERENCES network_devices(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'fiber'
                 CHECK (kind IN ('fiber', 'backhaul', 'drop', 'distribution')),
  path_json    JSONB,
  length_m     DOUBLE PRECISION,
  status       TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('up', 'down', 'degraded', 'unknown', 'planned')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX network_links_from ON network_links (from_id);
CREATE INDEX network_links_to   ON network_links (to_id);
