-- Bank paybills are SHARED. Equity (247247), KCB (522522), Co-op (400200) etc.
-- all front ONE M-Pesa paybill that every ISP banking there uses; the ISP is
-- distinguished by their own BANK ACCOUNT NUMBER, which the customer types as
-- the M-Pesa "account". The original model made `shortcode` globally unique —
-- correct for an ISP's OWN Safaricom paybill/till, but wrong for banks (two
-- Equity ISPs would collide on 247247). Add a per-ISP account number and make
-- THAT the unique routing key for bank rows; the shared paybill may repeat.

ALTER TABLE tenant_paybill ADD COLUMN IF NOT EXISTS account_no TEXT;

-- `shortcode` is no longer globally unique (banks legitimately share one).
ALTER TABLE tenant_paybill DROP CONSTRAINT IF EXISTS tenant_paybill_pkey;

-- An own Safaricom paybill / till still belongs to exactly ONE ISP.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_paybill_shortcode_nonbank
  ON tenant_paybill (shortcode) WHERE kind <> 'bank';

-- A bank account number belongs to exactly ONE ISP — the real bank routing key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_paybill_bank_account
  ON tenant_paybill (account_no) WHERE kind = 'bank' AND account_no IS NOT NULL;

-- Pre-fix bank rows registered the shared paybill as the routing key (account_no
-- NULL). They can't route anything under the new model and would needlessly
-- occupy the old shortcode; drop them so ISPs re-register with their account no.
DELETE FROM tenant_paybill WHERE kind = 'bank' AND account_no IS NULL;
