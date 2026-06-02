-- =====================================================================
-- Link hotspot_purchases to an existing service so renew-payment callbacks
-- know to restore that service rather than mint a new guest credential.
-- Null = hotspot guest purchase (original flow). Non-null = renew flow.
-- =====================================================================
ALTER TABLE hotspot_purchases ADD COLUMN service_id UUID REFERENCES services(id);
CREATE INDEX hotspot_purchases_service ON hotspot_purchases (service_id) WHERE service_id IS NOT NULL;
