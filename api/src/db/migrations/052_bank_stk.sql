-- Automated bank STK Push. A bank collection account can now fire the M-Pesa
-- prompt through the BANK's own STK Push API (Equity JengaHQ, KCB, ...) so the
-- money lands DIRECTLY in the ISP's bank account (matched by account_no) — the
-- bank holds the Safaricom relationship, the ISP just supplies their account.
--
--   provider = ''            -> manual: customer pays the paybill by hand (today)
--   provider = 'equity_jenga'-> fire STK via Equity JengaHQ / Jenga PGW
--   provider = 'kcb'         -> fire STK via KCB's STK Push API
--
-- The bank merchant API credentials live per-tenant-per-provider in `settings`
-- (write-only, same pattern as IntaSend/Kopo Kopo) — NOT here, so the account
-- row stays safe to return to the browser.

ALTER TABLE collection_account ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT '';
ALTER TABLE collection_account ADD COLUMN IF NOT EXISTS provider_env TEXT NOT NULL DEFAULT 'sandbox'
  CHECK (provider_env IN ('sandbox','live'));
