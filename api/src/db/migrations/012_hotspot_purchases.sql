-- =====================================================================
-- Hotspot guest purchases. Decoupled from the subscriber-linked payments
-- table so a captive-portal walk-in (M-Pesa STK) doesn't need a full
-- customer record. Each row tracks one STK push attempt; on Daraja
-- callback success we generate radcheck/radreply for the buyer.
-- =====================================================================

CREATE TABLE hotspot_purchases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_request_id TEXT UNIQUE NOT NULL,
  plan_id             UUID NOT NULL REFERENCES plans(id),
  phone               TEXT NOT NULL,
  mac_address         TEXT,
  amount_kes          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','success','failed','expired')),
  -- Populated on success — these are the credentials the portal hands back
  -- to MikroTik's hotspot login URL so the customer gets internet.
  username            TEXT,
  validity_seconds    INTEGER,
  rate_limit          TEXT,
  receipt             TEXT,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX hotspot_purchases_status ON hotspot_purchases (status);
CREATE INDEX hotspot_purchases_phone  ON hotspot_purchases (phone);
