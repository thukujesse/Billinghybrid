-- =====================================================================
-- tenant.last_error: why a provisioning attempt failed, for the platform
-- console's failed-tenant recovery. Set when provisionTenant/resumeProvision
-- throws; cleared (NULL) when a retry starts and on success. Lives in the
-- control DB's tenant registry (and harmlessly on tenant DBs, which carry an
-- unused copy of the control-plane tables).
-- =====================================================================
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS last_error TEXT;
