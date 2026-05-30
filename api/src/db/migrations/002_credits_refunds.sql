-- =====================================================================
-- Credit notes, refunds, and purchase tracking.
-- Fills the architecture doc's NET-NEW gaps: "Credit Notes & Adjustments"
-- and "Refund Workflows".
-- =====================================================================

-- ---------------------------------------------------------------------
-- Credit notes — issue account credit (optionally against an invoice).
-- When applied, the amount is credited to the subscriber's wallet.
-- ---------------------------------------------------------------------
CREATE TABLE credit_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number        TEXT NOT NULL UNIQUE,
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  invoice_id    UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  currency      TEXT NOT NULL DEFAULT 'KES',
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'applied'
                  CHECK (status IN ('issued','applied','void')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credit_notes_subscriber_idx ON credit_notes (subscriber_id);

-- ---------------------------------------------------------------------
-- Refunds — reverse a successful payment, in full or in part.
-- method 'wallet' debits the subscriber wallet (clawing back credited
-- funds); 'mpesa'/'manual' represent an external disbursement.
-- ---------------------------------------------------------------------
CREATE TABLE refunds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE SET NULL,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  currency      TEXT NOT NULL DEFAULT 'KES',
  reason        TEXT,
  method        TEXT NOT NULL CHECK (method IN ('wallet','mpesa','manual')),
  status        TEXT NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('pending','completed','failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
