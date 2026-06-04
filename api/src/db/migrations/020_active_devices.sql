-- =====================================================================
-- active_devices: denormalized fast-lookup table for returning-customer
-- auto-auth on the hotspot. One row per MAC currently inside a paid
-- window; expires_at is checked on lookup so stale rows naturally drop
-- out without a sweep job.
--
-- WHY DENORMALIZED: the captive-portal page calls /api/hotspot/lookup
-- on every connection; we need sub-ms lookup. Joining hotspot_purchases
-- + plans on every hit would be slow under load (cyber café at 50 phones
-- reconnecting at the start of the day).
--
-- POPULATED BY: trigger on hotspot_purchases (migration 021) so the
-- existing pay/voucher paths don't need any code changes — they just
-- write to hotspot_purchases as before and the trigger keeps this table
-- in sync. Direct INSERT/DELETE from the API is also fine (admin revoke,
-- SMS-OTP rebind to a new MAC).
--
-- MAC NORMALIZATION: stored as lowercase with colons (aa:bb:cc:dd:ee:ff).
-- The trigger lowercases; the lookup endpoint lowercases the input. The
-- FreeRADIUS authorize_check_query (sprint-2 queries.conf override) also
-- lowercases User-Name. One canonical format everywhere.
-- =====================================================================

CREATE TABLE active_devices (
  mac                      TEXT PRIMARY KEY,
  expires_at               TIMESTAMPTZ NOT NULL,
  rate_limit               TEXT,                                -- e.g. "5000k/2000k"
  session_timeout_seconds  INTEGER NOT NULL DEFAULT 3600,
  idle_timeout_seconds     INTEGER NOT NULL DEFAULT 600,
  source                   TEXT NOT NULL CHECK (source IN ('hotspot_purchase','voucher','admin','rebind')),
  phone                    TEXT,                                 -- M-Pesa phone (E.164) when known
  purchase_id              UUID REFERENCES hotspot_purchases(id) ON DELETE SET NULL,
  customer_id              UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- last_mac is the previous MAC for this phone when SMS-OTP rebind
  -- copied a grant onto a new randomized MAC. NULL on first capture.
  rebound_from_mac         TEXT,
  first_seen               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: lookup by mac filtered to live grants only.
CREATE INDEX active_devices_live ON active_devices (mac) WHERE expires_at > now();

-- Rebind path: find the most recent grant for a given phone.
CREATE INDEX active_devices_phone ON active_devices (phone, last_seen DESC) WHERE phone IS NOT NULL;
