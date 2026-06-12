-- Per-tenant prepaid SMS balance (control plane). Tenants WITHOUT their own
-- sender ID send via HubNet's shared sender and are charged KES 0.40 per 160-char
-- segment from this balance; the operator tops it up. Lives in the CONTROL DB.

CREATE TABLE IF NOT EXISTS tenant_sms_account (
  tenant_id    UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  balance_cents INT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_sms_ledger (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  delta_cents        INT NOT NULL,                 -- +topup / -charge / +refund
  balance_after_cents INT NOT NULL,
  reason             TEXT NOT NULL,                -- 'topup' | 'sms' | 'refund' | 'welcome'
  meta               TEXT,                         -- e.g. "2 segs -> 07xx"
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_sms_ledger_tenant ON tenant_sms_ledger(tenant_id, created_at DESC);
