-- Control plane (M2): the tenant registry. These tables live in the CONTROL DB
-- (the default databaseUrl). Host→tenant routing reads them on every request
-- BEFORE a tenant pool is bound, so the tenant service queries the default pool
-- directly (never the ALS-routed query()).
--
-- Each registered ISP gets its OWN database (db_conn_string). A NULL conn string
-- means "use the control/default DB" — that's the original single-tenant install,
-- seeded below so every existing hostname keeps resolving exactly as before.
--
-- NB: a freshly provisioned tenant DB also runs this migration, so it will carry
-- empty tenant/tenant_domain tables. That's harmless — only the control DB's copy
-- is ever consulted for routing.

CREATE TABLE IF NOT EXISTS tenant (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           TEXT NOT NULL UNIQUE,            -- url-safe; used as the subdomain label
  name           TEXT NOT NULL,                   -- ISP display name
  db_conn_string TEXT,                            -- NULL => the control/default DB
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('pending','provisioning','active','suspended','failed')),
  contact_phone  TEXT,
  contact_email  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_domain (
  host       TEXT PRIMARY KEY,                    -- exact hostname, lowercased, no port
  tenant_id  UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_domain_tenant ON tenant_domain(tenant_id);

-- Seed the existing install as the "default" tenant on the control DB, and map
-- every hostname it currently answers on. New hosts not listed here fall back to
-- this tenant too (see tenantMiddleware), so nothing breaks for unknown hosts.
INSERT INTO tenant (slug, name, status)
  VALUES ('default', 'HubNet', 'active')
  ON CONFLICT (slug) DO NOTHING;

INSERT INTO tenant_domain (host, tenant_id, is_primary)
  SELECT h.host, t.id, (h.host = 'demo.hubnetwifi.co.ke')
  FROM tenant t
  CROSS JOIN (VALUES
    ('demo.hubnetwifi.co.ke'),
    ('billing.hubnetwifi.co.ke'),
    ('portal.hubnetwifi.co.ke'),
    ('localhost')
  ) AS h(host)
  WHERE t.slug = 'default'
  ON CONFLICT (host) DO NOTHING;
