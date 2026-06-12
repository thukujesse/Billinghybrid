-- Platform billing (control plane): monthly invoices HubNet raises against each
-- ISP tenant. Lives in the CONTROL DB (alongside tenant/tenant_domain). A fresh
-- tenant DB also runs this migration and carries an empty copy — harmless, only
-- the control DB's rows are ever used.
--
-- Hybrid charge model (rates are config, snapshotted per invoice):
--   fixed_charge   = fixed_active (active non-hotspot services) * KES 25
--   hotspot_charge = hotspot_revenue * 3%

CREATE TABLE IF NOT EXISTS tenant_invoice (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period                TEXT NOT NULL,                 -- 'YYYY-MM'
  fixed_active          INT  NOT NULL DEFAULT 0,       -- active fixed-line subs counted
  fixed_per_sub_cents   INT  NOT NULL DEFAULT 0,       -- rate snapshot
  fixed_charge_cents    INT  NOT NULL DEFAULT 0,
  hotspot_revenue_cents BIGINT NOT NULL DEFAULT 0,     -- tenant's hotspot revenue in period
  hotspot_share_pct     NUMERIC(6,3) NOT NULL DEFAULT 0, -- rate snapshot
  hotspot_charge_cents  INT  NOT NULL DEFAULT 0,
  total_cents           INT  NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'KES',
  status                TEXT NOT NULL DEFAULT 'issued'
                          CHECK (status IN ('draft','issued','paid','void')),
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at               TIMESTAMPTZ,
  UNIQUE (tenant_id, period)
);
CREATE INDEX IF NOT EXISTS idx_tenant_invoice_tenant ON tenant_invoice(tenant_id);
