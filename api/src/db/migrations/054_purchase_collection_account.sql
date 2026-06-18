-- Attribute hotspot revenue to the collection account that received it (which
-- bank / paybill / till destination earned the money), alongside the router it
-- came from. Stamped at purchase time, like router_id. ON DELETE SET NULL: when
-- an account is deleted its attribution clears (that revenue rolls into
-- "Direct / global") rather than lingering under a ghost account.

ALTER TABLE hotspot_purchases ADD COLUMN IF NOT EXISTS collection_account_id UUID
  REFERENCES collection_account(id) ON DELETE SET NULL;
