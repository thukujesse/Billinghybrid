-- =====================================================================
-- Global hotspot branding: a single row that drives the captive portal's
-- logo, ISP name, tagline, and brand colour when no per-router slug
-- override exists. Operator edits these from /settings on the dashboard.
--
-- We keep per-router branding (routers.brand_*) as-is — it overrides
-- this global default when a router-specific slug is in the captive URL.
-- This singleton fills the "every other captive load" case.
--
-- logo_url is a data: URL (base64 PNG/JPG) so we don't need an external
-- object store. Logos are small (typical <50 KB). Anything bigger is
-- rejected at the API layer.
-- =====================================================================
CREATE TABLE IF NOT EXISTS hotspot_branding (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),   -- singleton row
  name          TEXT NOT NULL DEFAULT 'HUB Networks',
  tagline       TEXT NOT NULL DEFAULT 'Connect to Wi-Fi',
  color         TEXT NOT NULL DEFAULT '#2563eb',
  logo_url      TEXT,                                          -- data:image/...
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO hotspot_branding (id) VALUES (TRUE)
  ON CONFLICT (id) DO NOTHING;

-- Mirror logo_url onto routers so per-router slugs can override the logo too.
ALTER TABLE routers ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;