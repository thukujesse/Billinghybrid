-- =====================================================================
-- Multi-channel notification preferences per customer.
--
-- notification_channels is an array of channels (sms / email / whatsapp)
-- that the customer wants transactional messages on. The customer SMS
-- helper fans out a single message to every channel in the list — so a
-- customer can opt into both SMS and email to keep a written record, or
-- WhatsApp-only if they prefer not to use SMS.
--
-- Default {sms} preserves current behaviour for every existing customer.
-- Empty array = the customer opted out of all transactional comms
-- (escape hatch for "stop texting me").
-- =====================================================================
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notification_channels TEXT[] NOT NULL DEFAULT ARRAY['sms']::TEXT[];

-- Constraint guards against typos / bad values like 'sma' getting in.
DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_notification_channels_chk
    CHECK (notification_channels <@ ARRAY['sms','email','whatsapp']::TEXT[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
