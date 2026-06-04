-- =====================================================================
-- device_tokens: silent re-auth that survives MAC randomization.
--
-- The MAC-cookie + active_devices stack handles the common case (returning
-- customer with stable MAC). iOS/Android per-network MAC randomization
-- breaks that path: every reconnect looks like a new device, and the only
-- recovery we had was SMS-OTP (slow, costs money, friction).
--
-- A device_token is an opaque 32-byte random string the portal stores in
-- localStorage on first successful auth and presents on every future load.
-- We only store SHA-256 of the raw token — the raw value is never written
-- to the database and isn't recoverable if leaked from the DB alone.
--
-- The token binds {browser ↔ phone}, NOT {browser ↔ grant}. Auth flow:
--   1) Portal calls /hotspot/auto-reconnect with token + new MAC.
--   2) Server looks up token by SHA-256, finds the phone.
--   3) Server checks: does phone have a live active_devices grant?
--      - Yes → copy grant onto new MAC, rotate token, return active=true.
--      - No  → return active=false (customer must pay; their plan ended).
--
-- So the token replaces SMS-OTP for proving "I'm the same customer". It
-- does not grant free network access on its own — the plan still has to
-- be live. Token rotates on every successful use to limit replay.
-- =====================================================================

CREATE TABLE device_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash        TEXT NOT NULL UNIQUE,           -- SHA-256 hex; raw token never stored
  phone             TEXT NOT NULL,                  -- E.164, e.g. 2547XXXXXXXX
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Browser fingerprint: SHA-256 of canvas + UA + tz + screen + langs.
  -- Used only as a confidence signal (helps detect token theft when the
  -- presenting browser is clearly not the one we issued to). Never the
  -- sole basis for auto-auth.
  fingerprint_hash  TEXT,
  last_mac          TEXT,
  last_ip           INET,
  last_user_agent   TEXT,
  use_count         INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,           -- absolute TTL (issue +1y typical)
  revoked_at        TIMESTAMPTZ,
  revoke_reason     TEXT
);

-- Hot path: validate a presented token. Partial index keeps it tiny.
CREATE INDEX device_tokens_active ON device_tokens (token_hash)
  WHERE revoked_at IS NULL AND expires_at > now();

-- "What devices does this phone have?" (admin view + Forget All).
CREATE INDEX device_tokens_phone ON device_tokens (phone, last_used_at DESC)
  WHERE revoked_at IS NULL;
