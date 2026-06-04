-- =====================================================================
-- hotspot_rebind_otps: SMS-OTP flow for randomized-MAC recovery.
--
-- iOS 14+/Android 10+ default to per-network MAC randomization. The
-- returning-customer auto-auth (active_devices lookup by MAC) silently
-- breaks for these devices — a customer who paid yesterday connects
-- today with a different MAC and gets shown the payment UI.
--
-- The rebind flow lets them prove ownership via the phone number used
-- at payment time: portal sends OTP to that phone; on verify, we copy
-- the existing active_devices row onto the NEW MAC. They're back online
-- without re-paying.
--
-- Lifecycle: created on /hotspot/rebind/start, used on /verify, then
-- left around for audit (used_at set). Expired/used rows pile up but
-- there are few of them — periodic cleanup not worth a sweep job yet.
-- =====================================================================

CREATE TABLE hotspot_rebind_otps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT NOT NULL,        -- E.164, e.g. 2547XXXXXXXX
  code          TEXT NOT NULL,        -- 6-digit
  new_mac       TEXT NOT NULL,        -- lowercase with colons
  source_ip     INET,
  user_agent    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent OTP lookups by phone (rate-limit + dedup).
CREATE INDEX hotspot_rebind_otps_phone ON hotspot_rebind_otps (phone, created_at DESC);
