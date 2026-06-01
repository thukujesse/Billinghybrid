import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { config } from '../../config.js';
import { generateWgKeypair } from '../../lib/wireguard.js';
import * as wgManager from '../../lib/wgManager.js';

export interface Router {
  id: string;
  name: string;
  host: string;
  api_port: number;
  type: 'mikrotik' | 'radius';
  site: string | null;
  status: 'online' | 'offline' | 'degraded';
  created_at: string;
  wg_public_key: string | null;
  wg_tunnel_ip: string | null;
  vpn_status: 'pending' | 'connected' | 'disconnected';
  last_handshake_at: string | null;
}

// Columns safe to send to API clients — excludes wg_private_key and the
// provision_token fields, which are secrets only the admin who provisions
// (or the MikroTik via /provision/<token>) should ever see. vpn_status is
// derived from last_handshake_at freshness so it's always current.
const SAFE_COLS = `id, name, host, api_port, type, site, status, created_at,
  wg_public_key, wg_tunnel_ip, last_handshake_at,
  CASE
    WHEN last_handshake_at IS NULL THEN 'pending'
    WHEN last_handshake_at > now() - interval '3 minutes' THEN 'connected'
    ELSE 'disconnected'
  END AS vpn_status`;

export async function listRouters(): Promise<Router[]> {
  const r = await query<Router>(`SELECT ${SAFE_COLS} FROM routers ORDER BY created_at DESC`);
  return r.rows;
}

export async function getRouter(id: string): Promise<Router> {
  const r = await query<Router>(`SELECT ${SAFE_COLS} FROM routers WHERE id = $1`, [id]);
  if (!r.rows[0]) throw notFound('router');
  return r.rows[0];
}

/**
 * Poll wg-manager and update last_handshake_at for any peer that has a fresher
 * handshake than what's in the DB. Quiet on errors — heartbeat must not crash
 * the app, just log.
 */
export async function pollVpsHandshakes(): Promise<void> {
  if (!wgManager.isEnabled()) return;
  let peers;
  try {
    peers = await wgManager.listPeers();
  } catch (err) {
    console.error('[heartbeat] wg-manager unreachable:', (err as Error).message);
    return;
  }
  for (const peer of peers) {
    if (!peer.latestHandshake) continue;
    const handshakeIso = new Date(peer.latestHandshake * 1000).toISOString();
    await query(
      `UPDATE routers
          SET last_handshake_at = $2
        WHERE wg_public_key = $1
          AND (last_handshake_at IS NULL OR last_handshake_at < $2)`,
      [peer.publicKey, handshakeIso]
    );
  }
}

export async function createRouter(input: {
  name: string;
  host: string;
  api_port?: number;
  type?: 'mikrotik' | 'radius';
  site?: string;
  username?: string;
  password?: string;
}): Promise<Router> {
  const r = await query<Router>(
    `INSERT INTO routers (name, host, api_port, type, site, username, password)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.name, input.host, input.api_port ?? 8728, input.type ?? 'mikrotik', input.site ?? null, input.username ?? null, input.password ?? null]
  );
  return r.rows[0];
}

export interface ProvisionResult {
  router: Router;
  /** Single-line RouterOS command — fetch + import + cleanup. */
  oneLiner: string;
  /** The full .rsc script (also available; for power users). */
  mikrotikScript: string;
  /** Manual wg-set command for VPS — only populated when wg-manager is NOT configured. */
  vpsAddCommand?: string;
  /** True if the API auto-added the peer on the VPS via wg-manager. */
  vpsAutoAdded: boolean;
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) {
    throw badRequest(`invalid IPv4: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(int: number): string {
  return [(int >>> 24) & 0xff, (int >>> 16) & 0xff, (int >>> 8) & 0xff, int & 0xff].join('.');
}

/**
 * Allocate the next free tunnel IP within the configured WG network. .0 is
 * the network address, .1 is the server, .2 is reserved, broadcast is excluded.
 * Walks the whole CIDR — works for /24 (252 peers) up to /16 (65k peers).
 */
async function nextTunnelIp(): Promise<string> {
  const [base, maskStr] = config.wireguard.network.split('/');
  const mask = Number(maskStr);
  if (!base || isNaN(mask) || mask < 8 || mask > 30) {
    throw badRequest('invalid WG_NETWORK (expected CIDR like 10.66.0.0/16)');
  }
  const networkInt = (ipToInt(base) & ((0xffffffff << (32 - mask)) >>> 0)) >>> 0;
  const broadcastInt = (networkInt | ((1 << (32 - mask)) - 1)) >>> 0;

  const r = await query<{ wg_tunnel_ip: string }>(
    `SELECT wg_tunnel_ip FROM routers WHERE wg_tunnel_ip IS NOT NULL`
  );
  const taken = new Set(r.rows.map((x) => ipToInt(x.wg_tunnel_ip)));

  for (let i = networkInt + 3; i < broadcastInt; i++) {
    if (!taken.has(i)) return intToIp(i);
  }
  throw badRequest('WG tunnel network exhausted');
}

/** CIDR mask portion ("/16") for embedding in MikroTik address commands. */
function networkMask(): number {
  return Number(config.wireguard.network.split('/')[1]);
}

/**
 * Zero-touch router provisioning: generates a WG keypair, allocates a tunnel
 * IP, records the router, and returns both a RouterOS .rsc script (for paste
 * onto the MikroTik) and a `wg set` command (for paste on the VPS to register
 * the peer). The VPS-side auto-add comes in slice 2.
 */
export async function provisionRouter(input: {
  name: string;
  site?: string;
}): Promise<ProvisionResult> {
  if (!config.wireguard.serverPublicKey) {
    throw badRequest('WG_SERVER_PUBKEY not configured on the API');
  }
  const keys = generateWgKeypair();
  const tunnelIp = await nextTunnelIp();

  // URL-safe base64 token, 32 bytes = 256 bits entropy. Single-use, 24h expiry.
  const token = crypto.randomBytes(32).toString('base64url');
  // Per-router RADIUS shared secret. Stored in `nas` table for FreeRADIUS and
  // embedded in the RouterOS `/radius add ... secret=...` config so each
  // MikroTik authenticates uniquely to the central RADIUS server.
  const radiusSecret = crypto.randomBytes(24).toString('base64url');

  const r = await query<Router>(
    `INSERT INTO routers
       (name, host, type, site, wg_public_key, wg_private_key, wg_tunnel_ip, vpn_status,
        provision_token, provision_token_expires_at, radius_secret)
     VALUES ($1, $2, 'mikrotik', $3, $4, $5, $6, 'pending', $7, now() + interval '24 hours', $8)
     RETURNING ${SAFE_COLS}`,
    [input.name, tunnelIp, input.site ?? null, keys.publicKey, keys.privateKey, tunnelIp, token, radiusSecret]
  );
  const router = r.rows[0];

  // Register this MikroTik as a RADIUS client in the nas table so FreeRADIUS
  // trusts its Access-Requests. Idempotent — provisioning may re-run.
  await query(
    `INSERT INTO nas (nasname, shortname, type, secret, description)
     VALUES ($1, $2, 'mikrotik', $3, $4)
     ON CONFLICT (nasname) DO UPDATE SET secret = EXCLUDED.secret, shortname = EXCLUDED.shortname`,
    [tunnelIp, input.name.slice(0, 30), radiusSecret, `JTM ${input.name}`]
  );

  // Try to auto-add the peer on the VPS. If wg-manager isn't configured we
  // fall back to returning the manual command. If it IS configured but errors,
  // roll the DB insert back so the IP isn't burned on a half-provisioned peer.
  let vpsAutoAdded = false;
  if (wgManager.isEnabled()) {
    try {
      await wgManager.addPeer(keys.publicKey, tunnelIp);
      vpsAutoAdded = true;
    } catch (err) {
      await query('DELETE FROM routers WHERE id = $1', [router.id]);
      throw err;
    }
  }

  const mikrotikScript = renderRouterOsScript({
    routerName: router.name,
    tunnelIp,
    privateKey: keys.privateKey,
    serverPublicKey: config.wireguard.serverPublicKey,
    endpoint: config.wireguard.endpoint,
    tunnelNetwork: config.wireguard.network,
    pubkeyUrl: `${config.wireguard.managerUrl}/ssh-pubkey`,
    mgmtPassword: crypto.randomBytes(16).toString('base64url'),
    radiusSecret,
    radiusServerIp: config.wireguard.network.split('/')[0].replace(/0\.0$/, '0.1'),
  });

  const result: ProvisionResult = {
    router,
    oneLiner: renderOneLiner(token),
    mikrotikScript,
    vpsAutoAdded,
  };
  if (!vpsAutoAdded) {
    result.vpsAddCommand = renderVpsAddCommand(keys.publicKey, tunnelIp);
  }
  return result;
}

function renderOneLiner(token: string): string {
  const url = `${config.publicApiUrl}/api/provision/${token}`;
  return `/tool fetch url="${url}" dst-path=jtm.rsc; :delay 2s; /import jtm.rsc; /file remove jtm.rsc`;
}

/**
 * Look up a router by its provision token and produce the RouterOS script.
 * Single-use: marks the token consumed on first call. Throws if expired,
 * already used, or unknown.
 */
export async function fetchProvisionScript(token: string): Promise<string> {
  if (!config.wireguard.serverPublicKey) {
    throw badRequest('WG_SERVER_PUBKEY not configured on the API');
  }
  // Token is reusable within its 24h expiry window — first-use timestamp is
  // recorded once (audit) but doesn't lock the token. Idempotent so retries
  // and re-pastes during commissioning all work.
  const r = await query<{
    name: string;
    wg_private_key: string | null;
    wg_tunnel_ip: string | null;
  }>(
    `UPDATE routers
        SET provision_token_used_at = COALESCE(provision_token_used_at, now())
      WHERE provision_token = $1
        AND provision_token_expires_at > now()
      RETURNING name, wg_private_key, wg_tunnel_ip`,
    [token]
  );
  if (r.rowCount === 0) {
    const check = await query<{ expires_at: string | null }>(
      `SELECT provision_token_expires_at as expires_at
         FROM routers WHERE provision_token = $1`,
      [token]
    );
    if (check.rowCount === 0) throw notFound('provision token');
    throw badRequest('provision token expired');
  }
  const router = r.rows[0];
  if (!router.wg_private_key || !router.wg_tunnel_ip) {
    throw badRequest('router missing WG fields');
  }
  // Look up the router's stored radius_secret so the script is consistent
  // across re-fetches of the same provisioning token.
  const sr = await query<{ radius_secret: string | null }>(
    `SELECT radius_secret FROM routers WHERE provision_token = $1`, [token]);
  const radiusSecret = sr.rows[0]?.radius_secret ?? crypto.randomBytes(24).toString('base64url');

  return renderRouterOsScript({
    routerName: router.name,
    tunnelIp: router.wg_tunnel_ip,
    privateKey: router.wg_private_key,
    serverPublicKey: config.wireguard.serverPublicKey,
    endpoint: config.wireguard.endpoint,
    tunnelNetwork: config.wireguard.network,
    pubkeyUrl: `${config.wireguard.managerUrl}/ssh-pubkey`,
    mgmtPassword: crypto.randomBytes(16).toString('base64url'),
    radiusSecret,
    radiusServerIp: config.wireguard.network.split('/')[0].replace(/0\.0$/, '0.1'),
  });
}

function renderRouterOsScript(p: {
  routerName: string;
  tunnelIp: string;
  privateKey: string;
  serverPublicKey: string;
  endpoint: string;
  tunnelNetwork: string;
  pubkeyUrl: string;
  mgmtPassword: string;
  radiusSecret: string;
  radiusServerIp: string;
}): string {
  const [host, port] = p.endpoint.split(':');
  return `# --- JTM zero-touch provisioning for "${p.routerName}" ---
# Idempotent: cleans prior wg-jtm + management user state, then provisions
# WireGuard tunnel + a jtm-mgmt SSH user so the backend can push config via
# the tunnel. Safe to re-run.

:local ver [/system resource get version]
:if ([:pick $ver 0 1] != "7") do={ :error "RouterOS 7.x required. Found: $ver" }

# Clean up any prior WG state.
:if ([:len [/interface/wireguard find name=wg-jtm]] > 0) do={
  /ip/address remove [find interface=wg-jtm]
  /interface/wireguard remove [find name=wg-jtm]
}
:if ([:len [/interface/wireguard/peers find public-key="${p.serverPublicKey}"]] > 0) do={
  /interface/wireguard/peers remove [find public-key="${p.serverPublicKey}"]
}

# WireGuard tunnel.
/interface/wireguard add name=wg-jtm private-key="${p.privateKey}"
/interface/wireguard/peers add interface=wg-jtm \\
  public-key="${p.serverPublicKey}" \\
  endpoint-address=${host} endpoint-port=${port} \\
  allowed-address=${p.tunnelNetwork} \\
  persistent-keepalive=25s
/ip/address add interface=wg-jtm address=${p.tunnelIp}/${networkMask()}

# Management user "jtm-mgmt" — backend SSHs in as this user using a key we
# fetch below. Password is set but unused; SSH key auth is the access path.
:if ([:len [/user find name=jtm-mgmt]] = 0) do={
  /user add name=jtm-mgmt group=full disabled=no password="${p.mgmtPassword}"
}
/user/ssh-keys/remove [find user=jtm-mgmt]
/tool fetch url="${p.pubkeyUrl}" dst-path=jtm-mgr.pub
/user/ssh-keys/import public-key-file=jtm-mgr.pub user=jtm-mgmt
/file/remove [find name=jtm-mgr.pub]

# RADIUS: point at central server over the tunnel for PPP + Hotspot auth.
# Local /ppp secret store stays empty — all customers live in FreeRADIUS.
/radius remove [find comment="jtm-radius"]
/radius add service=ppp,hotspot address=${p.radiusServerIp} \\
  secret="${p.radiusSecret}" timeout=3s comment="jtm-radius"
/ppp aaa set use-radius=yes accounting=yes interim-update=1m
# Listen for RADIUS CoA (Disconnect-Message) on UDP 3799 from the central
# server, so admin "suspend" in the dashboard kicks active sessions instantly.
/radius incoming set accept=yes
:if ([:len [/ip/hotspot/profile find name=default]] > 0) do={
  /ip hotspot profile set [find name=default] use-radius=yes
}

:put "wg-jtm up at ${p.tunnelIp}. RADIUS server: ${p.radiusServerIp}. Customers in PPP secrets list should be 0 (auth is centralized)."
`;
}

function renderVpsAddCommand(peerPublicKey: string, tunnelIp: string): string {
  // Live-add the peer without reloading the whole interface. Persist by also
  // appending to /etc/wireguard/wg0.conf so it survives reboot.
  return [
    `sudo wg set wg0 peer "${peerPublicKey}" allowed-ips ${tunnelIp}/32`,
    `printf '\\n[Peer]\\nPublicKey = ${peerPublicKey}\\nAllowedIPs = ${tunnelIp}/32\\n' | sudo tee -a /etc/wireguard/wg0.conf >/dev/null`,
  ].join(' && ');
}

/**
 * Push a RouterOS command into the MikroTik via the WG tunnel (SSH on the
 * other side, terminated by wg-manager). Returns stdout/stderr/returncode.
 */
export async function execOnRouter(routerId: string, command: string): Promise<{
  stdout: string; stderr: string; returncode: number;
}> {
  const router = await getRouter(routerId);
  if (!router.wg_tunnel_ip) throw badRequest('router has no tunnel IP');
  return wgManager.execOnRouter(router.wg_tunnel_ip, command);
}

/** Assign a subscriber's service to a router. */
export async function assignSubscriber(subscriberId: string, routerId: string): Promise<void> {
  await getRouter(routerId);
  const r = await query('UPDATE subscribers SET router_id = $2 WHERE id = $1', [subscriberId, routerId]);
  if (r.rowCount === 0) throw notFound('subscriber');
}

/** The router a subscriber is homed on (or null). */
export async function routerForSubscriber(subscriberId: string): Promise<Router | null> {
  const r = await query<Router>(
    `SELECT ${SAFE_COLS.replace(/(^|,\s)/g, '$1rt.')} FROM routers rt
     JOIN subscribers s ON s.router_id = rt.id
     WHERE s.id = $1`,
    [subscriberId]
  );
  return r.rows[0] ?? null;
}
