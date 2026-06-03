-- =====================================================================
-- Per-router branding so the captive portal can show the venue's name,
-- colour, and tagline (hotel A vs cafe B). brand_slug goes into the
-- captive redirect URL (?tenant=<slug>); the portal page fetches
-- /api/hotspot/branding/<slug> to theme itself.
--
-- All columns optional — when null the portal falls back to default
-- HUB Networks branding.
-- =====================================================================

ALTER TABLE routers ADD COLUMN IF NOT EXISTS brand_slug    TEXT;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS brand_name    TEXT;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS brand_color   TEXT;
ALTER TABLE routers ADD COLUMN IF NOT EXISTS brand_tagline TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS routers_brand_slug_uniq
  ON routers (brand_slug) WHERE brand_slug IS NOT NULL;
