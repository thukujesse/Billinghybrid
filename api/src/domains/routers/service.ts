import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { config } from '../../config.js';
import { generateWgKeypair } from '../../lib/wireguard.js';

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

export async function listRouters(): Promise<Router[]> {
  const r = await query<Router>('SELECT * FROM routers ORDER BY created_at DESC');
  return r.rows;
}

export async function getRouter(id: string): Promise<Router> {
  const r = await query<Router>('SELECT * FROM routers WHERE id = $1', [id]);
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
  mikrotikScript: string;
  vpsAddCommand: string;
}

/**
 * Allocate the next free tunnel IP within the configured WG network. The VPS
 * holds .1 (server). We start handing out peers at .3 to leave .2 reserved for
 * any pre-existing manual client. Throws if the /24 is full.
 */
async function nextTunnelIp(): Promise<string> {
  const [base] = config.wireguard.network.split('/');
  const octets = base.split('.');
  if (octets.length !== 4) throw badRequest('invalid WG_NETWORK');
  const prefix = `${octets[0]}.${octets[1]}.${octets[2]}.`;

  const r = await query<{ wg_tunnel_ip: string }>(
    `SELECT wg_tunnel_ip FROM routers
     WHERE wg_tunnel_ip LIKE $1`,
    [`${prefix}%`]
  );
  const taken = new Set(r.rows.map((x) => x.wg_tunnel_ip));
  for (let i = 3; i <= 254; i++) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw badRequest('WG tunnel subnet exhausted');
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

  const r = await query<Router>(
    `INSERT INTO routers
       (name, host, type, site, wg_public_key, wg_private_key, wg_tunnel_ip, vpn_status)
     VALUES ($1, $2, 'mikrotik', $3, $4, $5, $6, 'pending')
     RETURNING *`,
    [input.name, tunnelIp, input.site ?? null, keys.publicKey, keys.privateKey, tunnelIp]
  );
  const router = r.rows[0];

  return {
    router,
    mikrotikScript: renderRouterOsScript({
      routerName: router.name,
      tunnelIp,
      privateKey: keys.privateKey,
      serverPublicKey: config.wireguard.serverPublicKey,
      endpoint: config.wireguard.endpoint,
      tunnelNetwork: config.wireguard.network,
    }),
    vpsAddCommand: renderVpsAddCommand(keys.publicKey, tunnelIp),
  };
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
/ip/address add interface=wg-jtm address=${p.tunnelIp}/24

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
    `SELECT rt.* FROM routers rt
     JOIN subscribers s ON s.router_id = rt.id
     WHERE s.id = $1`,
    [subscriberId]
  );
  return r.rows[0] ?? null;
}
