-- =====================================================================
-- Per-router SSH port. Default 22, but some MikroTiks have SSH moved to
-- non-standard ports (e.g., this user's HUBKERI5009 is on port 21). The
-- detect endpoint probes 22 / 21 / 2222 and stores whichever responds.
-- =====================================================================

ALTER TABLE routers ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22;
