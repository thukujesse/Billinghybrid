-- =====================================================================
-- Unified customer + service model (enterprise SDP layer).
-- A customer is the billing entity (a person or business). A customer
-- owns one or more services (pppoe, hotspot, static, ftth_gpon, ...).
-- Service lifecycle is the source of truth for RADIUS state: creating
-- an active service inserts radcheck/radreply rows; suspending writes
-- Auth-Type:=Reject; deleting removes radcheck/radreply.
-- =====================================================================

CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number  TEXT UNIQUE NOT NULL,
  full_name       TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'closed')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone ON customers (phone);

CREATE TABLE services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_type    TEXT NOT NULL
                    CHECK (service_type IN ('pppoe', 'hotspot', 'static', 'ftth_gpon')),
  -- PPPoE / Hotspot
  username        TEXT,
  password        TEXT,
  -- Static IP
  ip_address      TEXT,
  mac_address     TEXT,
  vlan_id         INTEGER,
  -- Routing / policy
  router_id       UUID REFERENCES routers(id) ON DELETE SET NULL,
  rate_limit      TEXT,    -- e.g. "20M/20M" — embedded in radreply
  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'expired', 'cancelled')),
  expiry_date     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX services_username_uniq
  ON services (username) WHERE username IS NOT NULL;
CREATE INDEX services_customer ON services (customer_id);
