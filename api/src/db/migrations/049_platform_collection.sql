-- Platform-fee collection (control plane): each STK push HubNet sends an ISP to
-- collect their monthly platform invoice. Lives in the CONTROL DB. The Daraja
-- callback matches by checkout_request_id, marks the invoice paid, and auto-
-- resumes a suspended tenant.

CREATE TABLE IF NOT EXISTS platform_collection (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  invoice_id          UUID REFERENCES tenant_invoice(id) ON DELETE SET NULL,
  period              TEXT,                          -- 'YYYY-MM' collected
  checkout_request_id TEXT UNIQUE,                   -- Daraja CheckoutRequestID
  amount_cents        INT NOT NULL,
  phone               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','success','failed')),
  mpesa_receipt       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_collection_tenant ON platform_collection(tenant_id, created_at DESC);
