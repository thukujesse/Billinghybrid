-- Per-router collection accounts (no-API methods only: paybill / till / bank).
-- An ISP can register several payment destinations and assign each MikroTik to
-- collect into one (or leave it on the default). Money lands directly in the
-- destination; HubNet's shared callback/IPN registry (tenant_paybill, control
-- DB) routes each confirmation back to the tenant by the destination number:
--   paybill -> the paybill number   till -> the till number   bank -> account_no
-- API gateways (STK / IntaSend / Kopo Kopo) stay global — money there follows
-- the API credentials, so per-router accounts don't apply to them.

CREATE TABLE IF NOT EXISTS collection_account (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label        TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('paybill','till','bank')),
  paybill      TEXT NOT NULL DEFAULT '',   -- paybill: the paybill; bank: the shared bank paybill (247247)
  till         TEXT NOT NULL DEFAULT '',   -- till method: the Buy-Goods till number
  account_no   TEXT NOT NULL DEFAULT '',   -- bank: the ISP's bank account number (the routing key)
  account_name TEXT NOT NULL DEFAULT '',   -- bank: name on the account
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most ONE default account per tenant DB (the "all routers collect here").
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_account_default
  ON collection_account (is_default) WHERE is_default;

-- A router optionally overrides to its own collection account; NULL = use default.
ALTER TABLE routers ADD COLUMN IF NOT EXISTS collection_account_id UUID
  REFERENCES collection_account(id) ON DELETE SET NULL;

-- Stamp each hotspot purchase with the router it came from (audit + routing).
ALTER TABLE hotspot_purchases ADD COLUMN IF NOT EXISTS router_id UUID;
