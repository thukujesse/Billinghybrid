-- =====================================================================
-- Voucher anti-sharing via MAC-lock.
--
-- Pre-change: redeemVoucher wrote radcheck keyed by the voucher CODE.
-- Any device with that code could log in (no MAC binding) — vouchers
-- traded on WhatsApp would let multiple phones use the same plan.
--
-- Post-change: on first redemption we record the MAC, insert an
-- active_devices row, and stop minting radcheck-by-code. Subsequent
-- logins go via FreeRADIUS's active_devices MAC-auth path (same as
-- M-Pesa-paid customers). A second device with the same code hits
-- voucher.status='used' and is rejected.
--
-- mac_address is nullable: legacy vouchers (issued before this column
-- existed) keep their pre-existing radcheck path until they're cleaned
-- up. Only new redemptions write the mac.
-- =====================================================================
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS mac_address TEXT;
CREATE INDEX IF NOT EXISTS vouchers_mac ON vouchers (mac_address) WHERE mac_address IS NOT NULL;