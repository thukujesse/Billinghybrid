-- =====================================================================
-- auto_reconnect_log: observability for the silent-auth pipeline.
--
-- We have four ways a returning customer can get back online without
-- payment UI: MikroTik MAC cookie, FreeRADIUS MAC-auth, portal MAC
-- lookup, and now device-token auto-reconnect (sprint 2.5). We need
-- to know how often each succeeds, how often we fall through to
-- payment, and how often a token is presented from a "wrong" browser.
--
-- Append-only. Never deleted automatically — operator can TRUNCATE
-- after exporting if size becomes an issue.
-- =====================================================================

CREATE TABLE auto_reconnect_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  method            TEXT NOT NULL CHECK (method IN ('mac','token','fingerprint','sms_otp','manual')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('success','no_match','expired','revoked','rate_limited','grant_expired','fingerprint_mismatch','error')),
  mac               TEXT,
  phone             TEXT,
  token_id          UUID REFERENCES device_tokens(id) ON DELETE SET NULL,
  fingerprint_match BOOLEAN,                          -- token presented + fingerprint matched stored one
  source_ip         INET,
  user_agent        TEXT,
  notes             TEXT
);

CREATE INDEX auto_reconnect_log_created ON auto_reconnect_log (created_at DESC);
CREATE INDEX auto_reconnect_log_phone   ON auto_reconnect_log (phone, created_at DESC)
  WHERE phone IS NOT NULL;
