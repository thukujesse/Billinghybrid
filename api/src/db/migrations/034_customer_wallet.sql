-- =====================================================================
-- Customer wallet — top-up once, system auto-debits on plan expiry.
-- Eliminates the per-renewal STK-push dance and lets customers prepay
-- (cash at the office goes into adjustment txns, M-Pesa goes through
-- the wallet_topup branch of hotspot_purchases).
--
-- balance_cents has a CHECK >= 0 enforced at the DB level — overdraft
-- is impossible even under concurrent debits, because the UPDATE that
-- would take it negative fails the check and the transaction rolls back.
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_wallets (
  customer_id    UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  balance_cents  BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only ledger. balance_after_cents is denormalized so the customer-
-- facing recent-txn list renders without computing running totals on read.
CREATE TABLE IF NOT EXISTS customer_wallet_txns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- topup        : credit from M-Pesa or cash
  -- renewal_debit: charged for a service renewal (auto or manual via portal)
  -- adjustment   : admin manual edit (refund, promo, correction)
  -- refund       : explicit refund to the customer
  kind                 TEXT NOT NULL CHECK (kind IN ('topup','renewal_debit','adjustment','refund')),
  -- Positive = credit, negative = debit. Always non-zero (zero-amount
  -- transactions are noise and pollute the ledger view).
  amount_cents         BIGINT NOT NULL CHECK (amount_cents <> 0),
  balance_after_cents  BIGINT NOT NULL,
  reference            TEXT,    -- m-pesa receipt, admin note, etc.
  service_id           UUID REFERENCES services(id) ON DELETE SET NULL,
  purchase_id          UUID REFERENCES hotspot_purchases(id) ON DELETE SET NULL,
  notes                TEXT,
  actor                TEXT NOT NULL DEFAULT 'system',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_wallet_txns_customer
  ON customer_wallet_txns (customer_id, created_at DESC);

-- Mark hotspot_purchases rows as wallet top-ups when the customer is paying
-- into their balance rather than for a specific service. Mutually exclusive
-- with service_id (one of: wallet_topup, service renewal, or guest hotspot).
ALTER TABLE hotspot_purchases
  ADD COLUMN IF NOT EXISTS wallet_topup_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- Per-service opt-in to auto-renewal from wallet. Default ON — the expire
-- worker checks this flag and tries the wallet debit before sending the
-- "expiring soon" SMS. Customers who explicitly turn it off (or who have
-- no wallet balance) fall through to the existing manual-renewal flow.
ALTER TABLE services ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT TRUE;
