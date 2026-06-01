-- =====================================================================
-- Serial-number-based router dedup. After WG tunnel comes up, the MikroTik
-- POSTs its serial number to /api/routers/identify. The API uses this to
-- merge duplicate router rows that point at the same physical device —
-- releasing tunnel IPs from older orphan rows back to the pool.
-- =====================================================================

ALTER TABLE routers ADD COLUMN serial_number TEXT;
CREATE INDEX routers_serial ON routers (serial_number) WHERE serial_number IS NOT NULL;
