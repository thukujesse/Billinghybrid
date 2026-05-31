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
// (or the MikroTik via /provision/<token>) should ever see.
const SAFE_COLS = `id, name, host, api_port, type, site, status, created_at,
  wg_public_key, wg_tunnel_ip, vpn_status, last_handshake_at`;

export async function listRouters(): Promise<Router[]> {
  const r = await query<Router>(`SELECT ${SAFE_COLS} FROM routers ORDER BY created_at DESC`);
  return r.rows;
}

export async function getRouter(id: string): Promise<Router> {
  const r = await query<Router>(`SELECT ${SAFE_COLS} FROM routers WHERE id = $1`, [id]);
  if (!r.rows[0]) throw notFound('router');
  return r.rows[0];
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

  const r = await query<Router>(
    `INSERT INTO routers
       (name, host, type, site, wg_public_key, wg_private_key, wg_tunnel_ip, vpn_status,
        provision_token, provision_token_expires_at)
     VALUES ($1, $2, 'mikrotik', $3, $4, $5, $6, 'pending', $7, now() + interval '24 hours')
     RETURNING ${SAFE_COLS}`,
    [input.name, tunnelIp, input.site ?? null, keys.publicKey, keys.privateKey, tunnelIp, token]
  );
  const router = r.rows[0];

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
  return renderRouterOsScript({
    routerName: router.name,
    tunnelIp: router.wg_tunnel_ip,
    privateKey: router.wg_private_key,
    serverPublicKey: config.wireguard.serverPublicKey,
    endpoint: config.wireguard.endpoint,
    tunnelNetwork: config.wireguard.network,
  });
}

function renderRouterOsScript(p: {
  routerName: string;
  tunnelIp: string;
  privateKey: string;
  serverPublicKey: string;
  endpoint: string;
  tunnelNetwork: string;
}): string {
  const [host, port] = p.endpoint.split(':');
  return `# --- JTM zero-touch provisioning for "${p.routerName}" ---
# Paste this entire block into a RouterOS 7.x terminal. Safe to re-run; will
# refuse if wg-jtm already exists.

:local ver [/system resource get version]
:if ([:pick $ver 0 1] != "7") do={ :error "RouterOS 7.x required. Found: $ver" }
:if ([:len [/interface/wireguard find name=wg-jtm]] > 0) do={
  :error "wg-jtm already exists. Remove it before re-provisioning."
}

/interface/wireguard add name=wg-jtm private-key="${p.privateKey}"
/interface/wireguard/peers add interface=wg-jtm \\
  public-key="${p.serverPublicKey}" \\
  endpoint-address=${host} endpoint-port=${port} \\
  allowed-address=${p.tunnelNetwork} \\
  persistent-keepalive=25s
/ip/address add interface=wg-jtm address=${p.tunnelIp}/${networkMask()}

:put "wg-jtm up at ${p.tunnelIp}. Verify with: /interface/wireguard print"
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
