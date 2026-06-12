-- Shared-callback routing (control plane): which paybill/till belongs to which
-- tenant. When a C2B confirmation hits HubNet's ONE shared callback URL, we read
-- the receiving BusinessShortCode from the payload, look it up here, and settle
-- the payment inside that tenant's database. Money already went to the ISP's own
-- account — HubNet only verifies + auto-connects.
--
-- Lives in the CONTROL DB. shortcode is the PK so two tenants can't claim the
-- same paybill (the registrar rejects a number already owned by another tenant).

CREATE TABLE IF NOT EXISTS tenant_paybill (
  shortcode  TEXT PRIMARY KEY,                 -- the receiving paybill / till number
  tenant_id  UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'paybill'   -- paybill | till | bank
               CHECK (kind IN ('paybill','till','bank')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_paybill_tenant ON tenant_paybill(tenant_id);
