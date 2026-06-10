-- =====================================================================
-- Vendor-agnostic network nodes. ONE table for every device in the chain
-- so the twin renders a uniform node set and never branches on vendor:
--   device_role = position in the chain (core|aggregation|distribution|cpe)
--   device_kind = what it physically is (olt, onu, fat, ap_sector, ...)
--   vendor      = driver dialect (hios|huawei|zte|... ) — DATA ONLY
--   transport   = how Phase 3 will poll it (snmp|ssh|telnet|rest|routeros)
-- parent_id builds the topology DAG (ONU -> FAT -> OLT -> core, or
-- CPE -> sector -> tower -> backhaul -> core). A MikroTik router also gets a
-- row here with router_id pointing back, so billing/provisioning keep using
-- the routers table unchanged while the twin sees one node set.
-- Typed per-kind attributes (PON ports, FAT capacity, optical RX/TX) live in
-- `meta` JSONB for now; promote to typed extension tables in Phase 3 if needed.
-- =====================================================================

CREATE TABLE network_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  device_role  TEXT NOT NULL DEFAULT 'distribution'
                 CHECK (device_role IN ('core', 'aggregation', 'distribution', 'cpe')),
  device_kind  TEXT NOT NULL
                 CHECK (device_kind IN ('router', 'switch', 'olt', 'onu', 'fat',
                                        'splitter', 'ap_sector', 'tower', 'backhaul',
                                        'pole', 'cpe')),
  vendor       TEXT,
  transport    TEXT,
  mgmt_ip      TEXT,
  status       TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('up', 'down', 'degraded', 'unknown', 'planned')),
  site_id      UUID REFERENCES sites(id) ON DELETE SET NULL,
  parent_id    UUID REFERENCES network_devices(id) ON DELETE SET NULL,
  router_id    UUID REFERENCES routers(id) ON DELETE SET NULL,
  latitude     DOUBLE PRECISION,
  longitude    DOUBLE PRECISION,
  capacity     INTEGER,                       -- generic: PON ports / FAT ports / sectors
  used_ports   INTEGER NOT NULL DEFAULT 0,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX network_devices_parent ON network_devices (parent_id);
CREATE INDEX network_devices_kind   ON network_devices (device_kind);
CREATE INDEX network_devices_site   ON network_devices (site_id);
