-- =====================================================================
-- Trigger: when a hotspot_purchases row settles successfully and has a
-- MAC captured, mirror it into active_devices.
--
-- Why an after-trigger instead of mutating active_devices from the TS
-- service: keeps the existing completePurchase() code path (and the
-- worker that drives it) unchanged. Voucher redeems also write through
-- (when we add MAC capture there). A future bulk-import or admin
-- credit/manual grant also flows through hotspot_purchases first.
--
-- ON CONFLICT (mac) DO UPDATE — if the same MAC pays again before the
-- previous grant expires, we extend (take the later expires_at, refresh
-- rate_limit, point at the new purchase). Doesn't break the partial
-- index because we're not orphaning the old expires_at.
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_active_devices_from_purchase() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'success'
     AND NEW.mac_address IS NOT NULL
     AND NEW.validity_seconds IS NOT NULL THEN
    INSERT INTO active_devices (
      mac, expires_at, rate_limit, session_timeout_seconds,
      source, phone, purchase_id
    ) VALUES (
      lower(NEW.mac_address),
      NEW.completed_at + (NEW.validity_seconds || ' seconds')::interval,
      NEW.rate_limit,
      NEW.validity_seconds,
      'hotspot_purchase',
      NEW.phone,
      NEW.id
    )
    ON CONFLICT (mac) DO UPDATE SET
      expires_at              = GREATEST(active_devices.expires_at, EXCLUDED.expires_at),
      rate_limit              = EXCLUDED.rate_limit,
      session_timeout_seconds = EXCLUDED.session_timeout_seconds,
      phone                   = COALESCE(EXCLUDED.phone, active_devices.phone),
      purchase_id             = EXCLUDED.purchase_id,
      source                  = EXCLUDED.source,
      last_seen               = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_active_devices_from_purchase
  AFTER INSERT OR UPDATE OF status ON hotspot_purchases
  FOR EACH ROW EXECUTE FUNCTION fn_active_devices_from_purchase();
