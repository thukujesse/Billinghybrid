-- =====================================================================
-- Generalize hotspot_rebind_otps for additional OTP-protected flows.
-- DPA-Kenya §40 requires a self-service erasure path (the customer
-- proves possession of the phone, then we wipe their identifiers).
-- Rather than build a parallel OTP table, the same SMS rate-limit and
-- audit pattern get re-used with a `purpose` column.
-- =====================================================================
ALTER TABLE hotspot_rebind_otps ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'rebind';

-- new_mac is only meaningful for the rebind purpose. Drop the NOT NULL
-- and add a conditional CHECK so 'rebind' rows still require a MAC.
ALTER TABLE hotspot_rebind_otps ALTER COLUMN new_mac DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE hotspot_rebind_otps
    ADD CONSTRAINT hotspot_rebind_otps_purpose_chk
    CHECK (purpose IN ('rebind','erase'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE hotspot_rebind_otps
    ADD CONSTRAINT hotspot_rebind_otps_mac_chk
    CHECK (purpose <> 'rebind' OR new_mac IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;