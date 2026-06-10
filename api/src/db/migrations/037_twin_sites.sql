-- =====================================================================
-- Network Digital Twin — Phase 1: physical sites (POP, tower base,
-- cabinet, datacenter). Pure STRUCTURE; liveness is overlaid at query
-- time from radacct. Coordinates are plain lat/lng (DOUBLE PRECISION) so
-- this ships on the 2GB box with no PostGIS dependency — the geometry/GIST
-- upgrade (nearest-FAT KNN etc.) is a later migration after the box move.
-- The twin is vendor-agnostic and read-mostly: it writes only its own
-- tables and never sits in the customer-auth path.
-- =====================================================================

CREATE TABLE sites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'pop'
                CHECK (type IN ('pop', 'tower', 'cabinet', 'datacenter', 'office', 'other')),
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  address     TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A router can belong to a site (its POP/tower). Additive + nullable.
ALTER TABLE routers ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE SET NULL;
