-- =====================================================================
-- WireGuard tunnel fields for the router fleet. Each router that gets
-- "zero-touch provisioned" has a unique keypair and a /32 in the tunnel
-- subnet so the backend (via a VPS relay) can reach it over WG.
-- =====================================================================

ALTER TABLE routers
  ADD COLUMN wg_public_key  TEXT,
  ADD COLUMN wg_private_key TEXT,
  ADD COLUMN wg_tunnel_ip   TEXT,
  ADD COLUMN vpn_status     TEXT NOT NULL DEFAULT 'pending'
    CHECK (vpn_status IN ('pending','connected','disconnected')),
  ADD COLUMN last_handshake_at TIMESTAMPTZ;

CREATE UNIQUE INDEX routers_wg_tunnel_ip_uniq
  ON routers (wg_tunnel_ip)
  WHERE wg_tunnel_ip IS NOT NULL;
