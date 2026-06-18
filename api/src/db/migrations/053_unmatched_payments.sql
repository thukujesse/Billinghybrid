-- Payment reconciliation: capture every C2B / bank / aggregator confirmation
-- that arrives WITHOUT matching a pending purchase (wrong amount, late, a typo'd
-- reference, or a fuzzy phone+amount bank match that missed). Previously these
-- were only console.warn'd and lost — the customer paid but got no access and the
-- operator had nothing to reconcile against. Now they land here for one-click
-- recovery (claim -> grant) or dismissal.

CREATE TABLE IF NOT EXISTS unmatched_payment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source      TEXT NOT NULL,                         -- c2b | jenga | bank_stk | intasend | kopokopo
  trans_id    TEXT NOT NULL,                         -- the provider's transaction id (dedup key)
  amount_kes  INTEGER NOT NULL,
  msisdn      TEXT NOT NULL DEFAULT '',              -- payer phone (best-effort)
  reference   TEXT NOT NULL DEFAULT '',              -- the account/reference the payer typed
  reason      TEXT NOT NULL,                         -- no_match | underpaid
  raw         JSONB,                                 -- full inbound payload (the statement line)
  status      TEXT NOT NULL DEFAULT 'unmatched'
                CHECK (status IN ('unmatched','claimed','ignored')),
  claimed_purchase_id UUID,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One row per provider transaction (a retried IPN must not duplicate it).
CREATE UNIQUE INDEX IF NOT EXISTS uq_unmatched_trans ON unmatched_payment (trans_id);
CREATE INDEX IF NOT EXISTS idx_unmatched_status ON unmatched_payment (status, created_at DESC);
