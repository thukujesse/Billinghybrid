-- =====================================================================
-- Advertisements — a local ad network on the hotspot platform. Per-tenant
-- (DB-per-tenant isolates each ISP's ads). v1 = rotating portal banners with
-- scheduling, per-router targeting, and impression/click counters. Later:
-- post-payment video, rewarded ads, speed-based image-vs-video rules.
-- Images are stored as data: URLs (like the logo); videos use an external URL.
-- =====================================================================

CREATE TABLE ads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  media_type       TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
  media_url        TEXT NOT NULL,                 -- data: URL (image) or external URL (video/image)
  link_url         TEXT,                          -- click-through destination
  placement        TEXT NOT NULL DEFAULT 'portal_banner'
                     CHECK (placement IN ('portal_banner', 'post_payment', 'dashboard')),
  target_router_id UUID REFERENCES routers(id) ON DELETE SET NULL,  -- NULL = all routers
  weight           INTEGER NOT NULL DEFAULT 1,    -- higher = shown more / first
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  impressions      BIGINT NOT NULL DEFAULT 0,
  clicks           BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ads_placement_active ON ads (placement, active);
CREATE INDEX ads_target_router ON ads (target_router_id);
