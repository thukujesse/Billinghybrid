-- =====================================================================
-- Per-router SSH port. The provisioning script's identify callback now
-- sends the MikroTik's own /ip service ssh port. We store it so future
-- Reprovision/Configure/Test/Exec calls SSH directly to the known port
-- instead of running the slow + flaky `probe-ssh` that hits 4 candidates.
-- =====================================================================

ALTER TABLE routers ADD COLUMN ssh_port INTEGER;
