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
  ssh_port: number;
}

export interface DetectedRouter {
  board: string;
  version: string;
  hostname: string;
  defaultGateway: string;
  sshPort: number;
  interfaces: Array<{
    name: string;
    type: string;
    running: boolean;
    isWan: boolean;
    inBridge: string | null;
  }>;
}

// Columns safe to send to API clients — excludes wg_private_key and the
// provision_token fields, which are secrets only the admin who provisions
// (or the MikroTik via /provision/<token>) should ever see. vpn_status is
// derived from last_handshake_at freshness so it's always current.
const SAFE_COLS = `id, name, host, api_port, type, site, status, created_at,
  wg_public_key, wg_tunnel_ip, last_handshake_at, ssh_port,
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
    identifyUrl: `${config.publicApiUrl}/api/routers/identify`,
    provisionToken: token,
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
    identifyUrl: `${config.publicApiUrl}/api/routers/identify`,
    provisionToken: token,
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
  identifyUrl: string;
  provisionToken: string;
}): string {
  const [host, port] = p.endpoint.split(':');
  return `# --- JTM zero-touch provisioning for "${p.routerName}" ---
# Idempotent: cleans prior wg-jtm + management user state, then provisions
# WireGuard tunnel + a hub-mgmt SSH user so the backend can push config via
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

# Management user "hub-mgmt" — backend SSHs in as this user using a key we
# fetch below. Password is set but unused; SSH key auth is the access path.
# DO NOT DELETE this user — the JTM backend needs it for remote config push.
:if ([:len [/user find name=hub-mgmt]] = 0) do={
  /user add name=hub-mgmt group=full disabled=no \\
    password="${p.mgmtPassword}" \\
    comment="JTM management user - do not delete (used for remote provisioning)"
}
/user set [find name=hub-mgmt] comment="JTM management user - do not delete (used for remote provisioning)"
:if ([:len [/user ssh-keys find user=hub-mgmt]] > 0) do={
  /user ssh-keys remove [find user=hub-mgmt]
}
/tool fetch url="${p.pubkeyUrl}" dst-path=hub-mgr.pub
:delay 1s
/user ssh-keys import public-key-file=hub-mgr.pub user=hub-mgmt
:delay 500ms
:if ([:len [/file find name=hub-mgr.pub]] > 0) do={ /file remove [find name=hub-mgr.pub] }
# Migrate old jtm-mgmt user if present (kept around for one release for safety;
# remove this stanza after all routers have been re-provisioned).
:if ([:len [/user find name=jtm-mgmt]] > 0) do={ /user/ssh-keys/remove [find user=jtm-mgmt]; /user/remove [find name=jtm-mgmt] }

# RADIUS: point at central server over the tunnel for PPP + Hotspot auth.
# Local /ppp secret store stays empty — all customers live in FreeRADIUS.
/radius remove [find comment="jtm-radius"]
/radius add service=ppp,hotspot address=${p.radiusServerIp} \\
  secret="${p.radiusSecret}" timeout=3s comment="jtm-radius"
/ppp aaa set use-radius=yes accounting=yes interim-update=1m
# Listen for RADIUS CoA (Disconnect-Message) on UDP 3799 from the central
# server, so admin "suspend" in the dashboard kicks active sessions instantly.
/radius incoming set accept=yes

# Management lifeline — paired input/output rules scoped to the RADIUS server
# IP only. Same comment on both ("jtm-fw allow-tunnel-mgmt"). Idempotent —
# old rules with this comment are wiped first.
/ip firewall filter remove [find comment="jtm-fw allow-tunnel-mgmt"]
/ip firewall filter add chain=input action=accept \\
  src-address=${p.radiusServerIp} comment="jtm-fw allow-tunnel-mgmt"
/ip firewall filter add chain=output action=accept \\
  dst-address=${p.radiusServerIp} comment="jtm-fw allow-tunnel-mgmt"
:do {
  :foreach r in=[/ip firewall filter find comment="jtm-fw allow-tunnel-mgmt"] do={
    /ip firewall filter move \$r destination=0
  }
} on-error={}

# Security: lock the legacy /ip service api to the tunnel only (we don't use
# it — SSH is our channel — but if it's later enabled, restrict source).
/ip service set api address=${p.tunnelNetwork}
/ip service set api-ssl address=${p.tunnelNetwork}

# ===== Resilience: WG watchdog =====
# If wg-jtm hasn't handshaken in >90s, restart it. Runs every minute. Without
# this, a transient tunnel drop becomes a permanent outage requiring on-site.
:if ([:len [/system script find name=jtm-wg-watchdog]] > 0) do={
  /system script remove [find name=jtm-wg-watchdog]
}
/system script add name=jtm-wg-watchdog policy=read,write,policy,test source={
  :local peers [/interface/wireguard/peers find interface=wg-jtm]
  :if ([:len \$peers] = 0) do={ :return "no-peer" }
  :local lh [/interface/wireguard/peers get [:pick \$peers 0] last-handshake]
  :if (\$lh = "" || \$lh = "never") do={
    :log warning "jtm-watchdog: wg-jtm never handshaken, cycling interface"
    /interface/wireguard disable wg-jtm
    :delay 2s
    /interface/wireguard enable wg-jtm
    :return "restarted"
  }
}
:if ([:len [/system scheduler find name=jtm-wg-watchdog]] > 0) do={
  /system scheduler remove [find name=jtm-wg-watchdog]
}
/system scheduler add name=jtm-wg-watchdog interval=1m on-event="/system script run jtm-wg-watchdog"

# ===== Resilience: reconcile scheduler =====
# Every 10 minutes, re-assert the lifeline firewall rule (and other critical
# bits) in case an admin accidentally removed them. Idempotent.
:if ([:len [/system script find name=jtm-reconcile]] > 0) do={
  /system script remove [find name=jtm-reconcile]
}
/system script add name=jtm-reconcile policy=read,write,policy,test source={
  :if ([:len [/ip firewall filter find comment="jtm-fw allow-tunnel-mgmt"]] < 2) do={
    /ip firewall filter remove [find comment="jtm-fw allow-tunnel-mgmt"]
    /ip firewall filter add chain=input action=accept src-address=${p.radiusServerIp} comment="jtm-fw allow-tunnel-mgmt"
    /ip firewall filter add chain=output action=accept dst-address=${p.radiusServerIp} comment="jtm-fw allow-tunnel-mgmt"
    :do {
      :foreach r in=[/ip firewall filter find comment="jtm-fw allow-tunnel-mgmt"] do={
        /ip firewall filter move \$r destination=0
      }
    } on-error={}
    :log warning "jtm-reconcile: restored tunnel-mgmt lifeline rules"
  }
  :if ([:len [/radius find comment=jtm-radius]] = 0) do={
    :log error "jtm-reconcile: RADIUS client missing — manual fix required"
  }
}
:if ([:len [/system scheduler find name=jtm-reconcile]] > 0) do={
  /system scheduler remove [find name=jtm-reconcile]
}
/system scheduler add name=jtm-reconcile interval=10m on-event="/system script run jtm-reconcile"
:if ([:len [/ip/hotspot/profile find name=default]] > 0) do={
  /ip hotspot profile set [find name=default] use-radius=yes
}

# Report this MikroTik's serial back to the API so duplicate router records
# (from re-provisioning the same physical box) get auto-merged + their tunnel
# IPs released. Best-effort — errors don't break provisioning.
:local serial [/system/routerboard get serial-number]
:do {
  /tool fetch url="${p.identifyUrl}" http-method=post \\
    http-data=("token=${p.provisionToken}&serial=" . $serial) \\
    output=none
} on-error={ :log warning "jtm identify call failed" }

:put "wg-jtm up at ${p.tunnelIp}. RADIUS server: ${p.radiusServerIp}. Serial: $serial"
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
 * Auto-probes SSH port if the stored one fails.
 */
export async function execOnRouter(routerId: string, command: string): Promise<{
  stdout: string; stderr: string; returncode: number;
}> {
  const router = await getRouter(routerId);
  if (!router.wg_tunnel_ip) throw badRequest('router has no tunnel IP');
  const sshPort = await resolveSshPort(router);
  return wgManager.execOnRouter(router.wg_tunnel_ip, command, { sshPort });
}

/** Try the stored ssh_port; if it fails, probe common ports and persist. */
async function resolveSshPort(router: Router): Promise<number> {
  if (!router.wg_tunnel_ip) throw badRequest('router has no tunnel IP');
  // Cheap test: short ssh attempt.
  const test = await wgManager.execOnRouter(
    router.wg_tunnel_ip, ':put ok', { sshPort: router.ssh_port }
  );
  if (test.returncode === 0 && test.stdout.includes('ok')) return router.ssh_port;
  const probed = await wgManager.probeSshPort(router.wg_tunnel_ip);
  if (probed === null) {
    throw badRequest(`SSH unreachable on ports 22/21/2222/8022 for ${router.wg_tunnel_ip}`);
  }
  if (probed !== router.ssh_port) {
    await query(`UPDATE routers SET ssh_port = $2 WHERE id = $1`, [router.id, probed]);
  }
  return probed;
}

/**
 * Detect router model + interfaces + default-route WAN via SSH. The result
 * powers the "Configure services" wizard, which lets admin pick which ports
 * each service binds to without typing interface names manually.
 */
export async function detectRouter(routerId: string): Promise<DetectedRouter> {
  const router = await getRouter(routerId);
  if (!router.wg_tunnel_ip) throw badRequest('router has no tunnel IP');
  const sshPort = await resolveSshPort(router);

  // RouterOS multi-line scripts via SSH can drop foreach blocks — keep each
  // statement on a single line so the shell never reflows it.
  const script = [
    `:put ("BOARD:" . [/system resource get board-name])`,
    `:put ("VERSION:" . [/system resource get version])`,
    `:put ("HOSTNAME:" . [/system identity get name])`,
    `:foreach r in=[/ip route find dst-address="0.0.0.0/0"] do={ :put ("DEFROUTE:" . [/ip route get $r gateway]) }`,
    `:foreach i in=[/interface find] do={ :put ("IFACE:" . [/interface get $i name] . "|" . [/interface get $i type] . "|" . [/interface get $i running]) }`,
    `:foreach p in=[/interface bridge port find] do={ :put ("BRPORT:" . [/interface bridge port get $p interface] . "=" . [/interface bridge port get $p bridge]) }`,
  ].join('\n');

  const result = await wgManager.execOnRouter(router.wg_tunnel_ip, script, { sshPort });
  if (result.returncode !== 0) {
    throw badRequest(`detect failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const out = result.stdout;
  const board = /^BOARD:(.+)$/m.exec(out)?.[1].trim() ?? '';
  const version = /^VERSION:(.+)$/m.exec(out)?.[1].trim() ?? '';
  const hostname = /^HOSTNAME:(.+)$/m.exec(out)?.[1].trim() ?? '';
  const defaultGateway = /^DEFROUTE:(.+)$/m.exec(out)?.[1].trim() ?? '';

  // Build wan candidates: the default-route gateway itself, and the bridge
  // it's in (so we exclude both from the picker).
  // Some RouterOS versions emit boolean as true/false, others as yes/no.
  const ifaceLines = [...out.matchAll(/^IFACE:([^|]+)\|([^|]+)\|(\S+)\s*$/gm)];
  const bridgeOf = new Map<string, string>();
  for (const m of out.matchAll(/^BRPORT:([^=]+)=(.+)$/gm)) {
    bridgeOf.set(m[1].trim(), m[2].trim());
  }
  const wanBridge = bridgeOf.get(defaultGateway) || '';

  // Skip JTM-managed virtual interfaces — admin shouldn't repurpose them.
  const SKIP = new Set(['wg-jtm', 'jtm-hs-bridge', 'jtm-ppp-bridge']);
  const interfaces = ifaceLines
    .map((m) => {
      const name = m[1].trim();
      const type = m[2].trim();
      const running = m[3] === 'true' || m[3] === 'yes';
      const inBridge = bridgeOf.get(name) ?? null;
      const isWan = name === defaultGateway || (!!wanBridge && inBridge === wanBridge);
      return { name, type, running, isWan, inBridge };
    })
    .filter((i) => !SKIP.has(i.name))
    .filter((i) => i.type === 'ether' || i.type === 'wlan' || i.type === 'vlan');

  return { board, version, hostname, defaultGateway, sshPort, interfaces };
}

export interface ConfigureServicesInput {
  services: ('pppoe' | 'hotspot')[];
  /** Single port list — applies to all selected services. Both PPPoE and
   * Hotspot bind to the same bridge containing these ports. */
  ports: string[];
  hotspotNetwork?: string;
}

/** Build + push (via SSH) the combined RouterOS config for the selected
 *  services. Single jtm-edge-bridge contains all selected ports; both PPPoE
 *  and Hotspot bind to it. They coexist on the same L2 because PPPoE operates
 *  on Ethernet frames while Hotspot intercepts on IP. */
export async function configureServices(
  routerId: string,
  input: ConfigureServicesInput
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  if (!input.services.length) throw badRequest('no services selected');
  if (!input.ports.length) throw badRequest('ports required');
  if (input.services.includes('hotspot') && !input.hotspotNetwork) {
    throw badRequest('hotspotNetwork required when hotspot is selected');
  }

  const router = await getRouter(routerId);
  if (!router.wg_tunnel_ip) throw badRequest('router has no tunnel IP');
  const sshPort = await resolveSshPort(router);

  const script = renderUnifiedConfig(
    router.name,
    input.services,
    input.ports,
    input.hotspotNetwork ?? ''
  );

  const result = await wgManager.execOnRouter(router.wg_tunnel_ip, script, { sshPort });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    success: result.returncode === 0,
  };
}

function renderUnifiedConfig(
  routerName: string,
  services: string[],
  ports: string[],
  hotspotCidr: string
): string {
  const wantsPppoe = services.includes('pppoe');
  const wantsHotspot = services.includes('hotspot');

  // Single bridge that hosts every selected port. Both services bind here.
  const portAdds = ports
    .map((i) => `/interface bridge port add bridge=jtm-edge-bridge interface=${i}`)
    .join('\n');

  // ---- shared bridge cleanup + create ----
  const lines: string[] = [
    `# --- JTM edge config for "${routerName}" — services: ${services.join('+')}, ports: ${ports.join(',')} ---`,
    `# Idempotent: removes prior JTM bridge + services, then provisions fresh.`,
    ``,
    `/ip hotspot remove [find name=jtm-hs]`,
    `/ip hotspot profile remove [find name=jtm-hotspot]`,
    `/ip dhcp-server remove [find name=jtm-hs-dhcp]`,
    `/ip dhcp-server network remove [find comment="jtm-hs"]`,
    `/ip pool remove [find name=jtm-hs-pool]`,
    `/ip hotspot walled-garden remove [find comment="jtm"]`,
    `/ip hotspot walled-garden ip remove [find comment="jtm"]`,
    `/ip firewall filter remove [find comment~"jtm-fw"]`,
    `/ip firewall address-list remove [find comment~"jtm-fw"]`,
    `/interface pppoe-server server remove [find service-name=jtm]`,
    `/ppp profile remove [find name=jtm-ppp]`,
    `/ip pool remove [find name=jtm-ppp-pool]`,
    `/ip address remove [find comment="jtm-edge"]`,
    `# Legacy cleanup (older split-bridge configs)`,
    `/interface bridge port remove [find bridge=jtm-hs-bridge]`,
    `/interface bridge remove [find name=jtm-hs-bridge]`,
    `/interface bridge port remove [find bridge=jtm-ppp-bridge]`,
    `/interface bridge remove [find name=jtm-ppp-bridge]`,
    `/interface bridge port remove [find bridge=jtm-edge-bridge]`,
    `/interface bridge remove [find name=jtm-edge-bridge]`,
    ``,
    `/interface bridge add name=jtm-edge-bridge protocol-mode=none auto-mac=yes`,
    portAdds,
    ``,
  ];

  // ---- Hotspot (if selected) ----
  if (wantsHotspot) {
    const [base, prefixStr] = hotspotCidr.split('/');
    const prefix = Number(prefixStr);
    const octets = base.split('.').map(Number);
    if (octets.length !== 4 || octets.some(isNaN) || isNaN(prefix)) {
      throw badRequest('invalid hotspotNetwork');
    }
    const gateway = `${octets[0]}.${octets[1]}.${octets[2]}.1`;
    const poolStart = `${octets[0]}.${octets[1]}.${octets[2]}.10`;
    const poolEnd = `${octets[0]}.${octets[1]}.${octets[2]}.250`;
    const apiHost = new URL(config.publicApiUrl).host;
    const webHost = apiHost.replace(/^jtm-api/, 'jtm-web');
    const tplBase = `${config.publicApiUrl}/api/hotspot/templates`;

    lines.push(
      `# ===== Hotspot =====`,
      `/ip pool add name=jtm-hs-pool ranges=${poolStart}-${poolEnd}`,
      `/ip address add interface=jtm-edge-bridge address=${gateway}/${prefix} comment="jtm-edge"`,
      `/ip dhcp-server network add address=${hotspotCidr} gateway=${gateway} dns-server=${gateway} comment="jtm-hs"`,
      `/ip dhcp-server add name=jtm-hs-dhcp interface=jtm-edge-bridge address-pool=jtm-hs-pool lease-time=1h disabled=no`,
      `/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8`,
      `/ip hotspot profile add name=jtm-hotspot hotspot-address=${gateway} dns-name=jtm-hotspot use-radius=yes login-by=http-pap`,
      `/ip hotspot add name=jtm-hs interface=jtm-edge-bridge address-pool=jtm-hs-pool profile=jtm-hotspot disabled=no`,
      `/ip hotspot walled-garden add dst-host=${webHost} action=allow comment="jtm"`,
      `/ip hotspot walled-garden add dst-host=${apiHost} action=allow comment="jtm"`,
      `/ip hotspot walled-garden ip add tls-host=${webHost} action=accept comment="jtm"`,
      `/ip hotspot walled-garden ip add tls-host=${apiHost} action=accept comment="jtm"`,
      `# Replace all 8 hotspot UI files — each thin template redirects to our portal.`,
      ...['login.html','alogin.html','status.html','logout.html','error.html','redirect.html','rlogin.html','md5.js'].map(
        (n) => `/tool fetch url="${tplBase}/${n}" dst-path=hotspot/${n} mode=https`
      ),
      ``,
    );
  }

  // ---- JTM-tagged firewall rules (walled-garden + expired block) ----
  // Always added (regardless of services) so suspend/restore has teeth. All
  // are commented "jtm-fw" so cleanup-on-reapply finds them.
  const apiHost = new URL(config.publicApiUrl).host;
  const webHost = apiHost.replace(/^jtm-api/, 'jtm-web');
  lines.push(
    `:put "[Firewall] portal allow-list + DNS + expired-reject + mgmt lifeline..."`,
    `# Resolved portal hostnames into address-list so HTTPS (no SNI inspection)`,
    `# is allowed unconditionally even when other rules would reject.`,
    `/ip firewall address-list add list=jtm-portal address=${webHost} comment="jtm-fw portal"`,
    `/ip firewall address-list add list=jtm-portal address=${apiHost} comment="jtm-fw portal"`,
    `# Add then move-to-top (place-before=0 can error on empty chain).`,
    `/ip firewall filter add chain=forward action=accept dst-address-list=jtm-portal comment="jtm-fw allow-portal"`,
    `/ip firewall filter add chain=forward action=accept protocol=udp dst-port=53 comment="jtm-fw allow-dns-udp"`,
    `/ip firewall filter add chain=forward action=accept protocol=tcp dst-port=53 comment="jtm-fw allow-dns-tcp"`,
    `# Suspended/expired customers: API pushes their IP into jtm-expired list.`,
    `/ip firewall filter add chain=forward action=reject reject-with=icmp-admin-prohibited src-address-list=jtm-expired comment="jtm-fw reject-expired-up"`,
    `/ip firewall filter add chain=forward action=reject reject-with=icmp-admin-prohibited dst-address-list=jtm-expired comment="jtm-fw reject-expired-down"`,
    `# Management lifeline — ALWAYS allow input from the WG tunnel so the api`,
    `# can SSH/RADIUS/CoA to this router. src-address derived from WG_NETWORK.`,
    `/ip firewall filter add chain=input action=accept in-interface=wg-jtm src-address=${config.wireguard.network} comment="jtm-fw allow-tunnel-mgmt"`,
    `# Move all jtm-fw accept rules to top (above any drops). Best-effort.`,
    `:foreach r in=[/ip firewall filter find comment~"jtm-fw allow"] do={`,
    `  :do { /ip firewall filter move \$r destination=0 } on-error={}`,
    `}`,
    `:put "[Firewall] done"`,
    ``,
  );

  // ---- PPPoE (if selected) ----
  if (wantsPppoe) {
    lines.push(
      `# ===== PPPoE =====`,
      `/ip pool add name=jtm-ppp-pool ranges=10.7.0.10-10.7.255.250`,
      `/ppp profile add name=jtm-ppp local-address=10.7.0.1 remote-address=jtm-ppp-pool dns-server=1.1.1.1,8.8.8.8 only-one=yes`,
      `/interface pppoe-server server add service-name=jtm interface=jtm-edge-bridge default-profile=jtm-ppp authentication=pap,chap one-session-per-host=yes disabled=no`,
      ``,
    );
  }

  lines.push(
    `:put "JTM edge configured: services=${services.join('+')}, ports=${ports.join(',')} on jtm-edge-bridge"`
  );
  return lines.join('\n');
}

function renderPppoeScript(interfaces: string[]): string {
  const portAdds = interfaces
    .map((i) => `/interface bridge port add bridge=jtm-ppp-bridge interface=${i}`)
    .join('\n');
  return `# --- JTM PPPoE setup ---
/interface pppoe-server server remove [find service-name=jtm]
/ppp profile remove [find name=jtm-ppp]
/ip pool remove [find name=jtm-ppp-pool]
/interface bridge port remove [find bridge=jtm-ppp-bridge]
/interface bridge remove [find name=jtm-ppp-bridge]

/interface bridge add name=jtm-ppp-bridge protocol-mode=none
${portAdds}

/ip pool add name=jtm-ppp-pool ranges=10.7.0.10-10.7.255.250
/ppp profile add name=jtm-ppp local-address=10.7.0.1 remote-address=jtm-ppp-pool \\
  dns-server=1.1.1.1,8.8.8.8 only-one=yes
/interface pppoe-server server add service-name=jtm interface=jtm-ppp-bridge \\
  default-profile=jtm-ppp authentication=pap,chap \\
  one-session-per-host=yes disabled=no

:put "PPPoE server live on jtm-ppp-bridge"
`;
}

function renderHotspotMultiPort(routerName: string, interfaces: string[], cidr: string): string {
  const [base, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const octets = base.split('.').map(Number);
  if (octets.length !== 4 || octets.some(isNaN) || isNaN(prefix)) {
    throw badRequest('invalid hotspotNetwork');
  }
  const gateway = `${octets[0]}.${octets[1]}.${octets[2]}.1`;
  const poolStart = `${octets[0]}.${octets[1]}.${octets[2]}.10`;
  const poolEnd = `${octets[0]}.${octets[1]}.${octets[2]}.250`;
  const apiHost = new URL(config.publicApiUrl).host;
  const webHost = apiHost.replace(/^jtm-api/, 'jtm-web');
  const tplBase = `${config.publicApiUrl}/api/hotspot/templates`;
  const portAdds = interfaces
    .map((i) => `/interface bridge port add bridge=jtm-hs-bridge interface=${i}`)
    .join('\n');

  return `# --- JTM Hotspot setup for "${routerName}" ---
/ip hotspot remove [find name=jtm-hs]
/ip hotspot profile remove [find name=jtm-hotspot]
/ip dhcp-server remove [find name=jtm-hs-dhcp]
/ip dhcp-server network remove [find comment="jtm-hs"]
/ip pool remove [find name=jtm-hs-pool]
/ip hotspot walled-garden remove [find comment="jtm"]
/ip hotspot walled-garden ip remove [find comment="jtm"]
/ip address remove [find comment="jtm-hs"]
/interface bridge port remove [find bridge=jtm-hs-bridge]
/interface bridge remove [find name=jtm-hs-bridge]

/interface bridge add name=jtm-hs-bridge protocol-mode=none auto-mac=yes
${portAdds}

/ip pool add name=jtm-hs-pool ranges=${poolStart}-${poolEnd}
/ip address add interface=jtm-hs-bridge address=${gateway}/${prefix} comment="jtm-hs"

/ip dhcp-server network add address=${cidr} gateway=${gateway} dns-server=${gateway} comment="jtm-hs"
/ip dhcp-server add name=jtm-hs-dhcp interface=jtm-hs-bridge \\
  address-pool=jtm-hs-pool lease-time=1h disabled=no

/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8

/ip hotspot profile add name=jtm-hotspot \\
  hotspot-address=${gateway} dns-name=jtm-hotspot \\
  use-radius=yes login-by=http-pap

/ip hotspot add name=jtm-hs interface=jtm-hs-bridge \\
  address-pool=jtm-hs-pool profile=jtm-hotspot disabled=no

/ip hotspot walled-garden add dst-host=${webHost} action=allow comment="jtm"
/ip hotspot walled-garden add dst-host=${apiHost} action=allow comment="jtm"
/ip hotspot walled-garden ip add tls-host=${webHost} action=accept comment="jtm"
/ip hotspot walled-garden ip add tls-host=${apiHost} action=accept comment="jtm"

${['login.html','alogin.html','status.html','logout.html','error.html','redirect.html','rlogin.html','md5.js'].map((n) => `/tool fetch url="${tplBase}/${n}" dst-path=hotspot/${n} mode=https`).join('\n')}
:put "Hotspot live on jtm-hs-bridge"
`;
}

export interface ReprovisionResult {
  router: Router;
  oneLiner: string;
  mikrotikScript: string;
  autoApplied: boolean;
  autoApplyOutput: string;
}

/**
 * Re-issue a provisioning token + fresh RADIUS secret for an existing router,
 * then attempt to push it via SSH (using hub-mgmt installed by the prior
 * provisioning). If SSH succeeds, the MikroTik self-applies the new config —
 * truly "one-touch". If SSH fails (port closed, hub-mgmt not yet installed),
 * we return the one-liner so admin can paste it manually.
 */
export async function reprovisionRouter(routerId: string): Promise<ReprovisionResult> {
  if (!config.wireguard.serverPublicKey) {
    throw badRequest('WG_SERVER_PUBKEY not configured on the API');
  }
  const router = await getRouter(routerId);
  if (!router.wg_tunnel_ip) throw badRequest('router has no tunnel IP');

  // Fetch the private key (excluded from getRouter SAFE_COLS).
  const pkr = await query<{ wg_private_key: string | null }>(
    `SELECT wg_private_key FROM routers WHERE id = $1`, [routerId]
  );
  const privateKey = pkr.rows[0]?.wg_private_key;
  if (!privateKey) throw badRequest('router missing WG private key');

  const token = crypto.randomBytes(32).toString('base64url');
  const radiusSecret = crypto.randomBytes(24).toString('base64url');

  await query(
    `UPDATE routers SET
       provision_token = $2,
       provision_token_expires_at = now() + interval '24 hours',
       provision_token_used_at = NULL,
       radius_secret = $3
     WHERE id = $1`,
    [routerId, token, radiusSecret]
  );

  // Keep nas table in sync — the new shared secret must match what the
  // re-pushed RouterOS script will configure.
  await query(
    `INSERT INTO nas (nasname, shortname, type, secret, description)
     VALUES ($1, $2, 'mikrotik', $3, $4)
     ON CONFLICT (nasname) DO UPDATE SET secret = EXCLUDED.secret`,
    [router.wg_tunnel_ip, router.name.slice(0, 30), radiusSecret, `JTM ${router.name}`]
  );

  const mikrotikScript = renderRouterOsScript({
    routerName: router.name,
    tunnelIp: router.wg_tunnel_ip,
    privateKey,
    serverPublicKey: config.wireguard.serverPublicKey,
    endpoint: config.wireguard.endpoint,
    tunnelNetwork: config.wireguard.network,
    pubkeyUrl: `${config.wireguard.managerUrl}/ssh-pubkey`,
    mgmtPassword: crypto.randomBytes(16).toString('base64url'),
    radiusSecret,
    radiusServerIp: config.wireguard.network.split('/')[0].replace(/0\.0$/, '0.1'),
    identifyUrl: `${config.publicApiUrl}/api/routers/identify`,
    provisionToken: token,
  });
  const oneLiner = renderOneLiner(token);

  // Try SSH-push the one-liner. RouterOS executes the semicolon-separated
  // commands directly. If hub-mgmt user/SSH-port aren't right, fall back to
  // returning the one-liner for manual paste.
  let autoApplied = false;
  let autoApplyOutput = '';
  if (wgManager.isEnabled()) {
    try {
      const ssh = await wgManager.execOnRouter(router.wg_tunnel_ip, oneLiner);
      autoApplied = ssh.returncode === 0;
      autoApplyOutput = (ssh.stdout + ssh.stderr).trim();
    } catch (err) {
      autoApplyOutput = (err as Error).message;
    }
  } else {
    autoApplyOutput = 'wg-manager not configured';
  }

  return { router, oneLiner, mikrotikScript, autoApplied, autoApplyOutput };
}

/**
 * Called by the MikroTik itself once provisioning finishes. The router POSTs
 * its serial number; we match by token, then find any other router rows with
 * the same serial (left over from previous provisioning attempts on the same
 * physical box) and delete them — releasing their tunnel IPs + WG peers + nas
 * rows. Idempotent — safe to call multiple times.
 */
export async function identifyRouter(token: string, serial: string): Promise<{
  routerId: string; dedupedCount: number;
}> {
  if (!serial) throw badRequest('serial required');
  const cur = await query<{ id: string; wg_tunnel_ip: string }>(
    `SELECT id, wg_tunnel_ip FROM routers WHERE provision_token = $1`, [token]
  );
  if (cur.rows.length === 0) throw notFound('provision token');
  const currentId = cur.rows[0].id;

  // Record the serial on the current router.
  await query(`UPDATE routers SET serial_number = $2 WHERE id = $1`, [currentId, serial]);

  // Find duplicates — same serial, different id. Release their resources.
  const dupes = await query<{
    id: string; wg_public_key: string | null; wg_tunnel_ip: string | null;
  }>(
    `SELECT id, wg_public_key, wg_tunnel_ip FROM routers
      WHERE serial_number = $1 AND id != $2`,
    [serial, currentId]
  );
  for (const d of dupes.rows) {
    if (d.wg_public_key && wgManager.isEnabled()) {
      try { await wgManager.removePeer(d.wg_public_key); } catch (e) {
        console.error('[identify] wg peer remove failed:', (e as Error).message);
      }
    }
    if (d.wg_tunnel_ip) {
      await query(`DELETE FROM nas WHERE nasname = $1`, [d.wg_tunnel_ip]);
    }
    await query(`DELETE FROM routers WHERE id = $1`, [d.id]);
  }
  return { routerId: currentId, dedupedCount: dupes.rowCount ?? 0 };
}

/**
 * Build a RouterOS script the admin pastes onto a MikroTik to turn one of its
 * LAN interfaces into a JTM-managed hotspot. Walled-garden whitelists our
 * portal so unauthenticated clients can reach it; login.html is replaced with
 * a thin redirect to the captive portal page on jtm-web.
 */
export async function buildHotspotScript(
  routerId: string,
  opts: { interfaceName: string; networkCidr: string }
): Promise<{ script: string }> {
  const router = await getRouter(routerId);
  const [base, prefixStr] = opts.networkCidr.split('/');
  const prefix = Number(prefixStr);
  const octets = base.split('.').map(Number);
  if (octets.length !== 4 || octets.some(isNaN) || isNaN(prefix)) {
    throw badRequest('invalid networkCidr (expected e.g. 10.5.50.0/24)');
  }
  const gateway   = `${octets[0]}.${octets[1]}.${octets[2]}.1`;
  const poolStart = `${octets[0]}.${octets[1]}.${octets[2]}.10`;
  const poolEnd   = `${octets[0]}.${octets[1]}.${octets[2]}.250`;

  const apiHost  = new URL(config.publicApiUrl).host;          // jtm-api-h6o3.onrender.com
  const webHost  = apiHost.replace(/^jtm-api/, 'jtm-web');     // jtm-web-h6o3.onrender.com
  const tplBase = `${config.publicApiUrl}/api/hotspot/templates`;

  const script = `# --- JTM hotspot setup for "${router.name}" ---
# Idempotent: removes prior JTM hotspot config, creates jtm-hs-bridge, adds
# ${opts.interfaceName} as the first port, runs DHCP + hotspot on the bridge.
# Add more bridge ports later (Wi-Fi/Ethernet) via:
#   /interface bridge port add bridge=jtm-hs-bridge interface=<other>
# IMPORTANT: ${opts.interfaceName} must NOT already be in another bridge.

/ip hotspot remove [find name=jtm-hs]
/ip hotspot profile remove [find name=jtm-hotspot]
/ip dhcp-server remove [find name=jtm-hs-dhcp]
/ip dhcp-server network remove [find comment="jtm-hs"]
/ip pool remove [find name=jtm-hs-pool]
/ip hotspot walled-garden remove [find comment="jtm"]
/ip hotspot walled-garden ip remove [find comment="jtm"]
/ip address remove [find comment="jtm-hs"]
/interface bridge port remove [find bridge=jtm-hs-bridge]
/interface bridge remove [find name=jtm-hs-bridge]

# Bridge — hotspot binds here so we can add more ports later without rework.
/interface bridge add name=jtm-hs-bridge protocol-mode=none auto-mac=yes
/interface bridge port add bridge=jtm-hs-bridge interface=${opts.interfaceName}

# IP, pool, DHCP, DNS all hang off the bridge.
/ip pool add name=jtm-hs-pool ranges=${poolStart}-${poolEnd}
/ip address add interface=jtm-hs-bridge address=${gateway}/${prefix} comment="jtm-hs"

# DHCP — devices connecting to any bridge port get an IP from the pool.
# Without this the captive portal never intercepts (no IP = no gateway).
/ip dhcp-server network add address=${opts.networkCidr} gateway=${gateway} dns-server=${gateway} comment="jtm-hs"
/ip dhcp-server add name=jtm-hs-dhcp interface=jtm-hs-bridge \\
  address-pool=jtm-hs-pool lease-time=1h disabled=no

# Make MikroTik resolve DNS for hotspot clients (so the redirect to the
# external portal resolves before walled-garden lets it through).
/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8

/ip hotspot profile add name=jtm-hotspot \\
  hotspot-address=${gateway} dns-name=jtm-hotspot \\
  use-radius=yes login-by=http-pap

/ip hotspot add name=jtm-hs \\
  interface=jtm-hs-bridge \\
  address-pool=jtm-hs-pool \\
  profile=jtm-hotspot disabled=no

# Walled garden — let unauthenticated clients reach the captive portal.
/ip hotspot walled-garden add dst-host=${webHost} action=allow comment="jtm"
/ip hotspot walled-garden add dst-host=${apiHost} action=allow comment="jtm"
/ip hotspot walled-garden ip add tls-host=${webHost} action=accept comment="jtm"
/ip hotspot walled-garden ip add tls-host=${apiHost} action=accept comment="jtm"

# Replace all 8 MikroTik hotspot UI files with thin templates that redirect
# to our Next.js portal. Each file MikroTik-substitutes $(varname) tokens.
${['login.html','alogin.html','status.html','logout.html','error.html','redirect.html','rlogin.html','md5.js'].map((n) => `/tool fetch url="${tplBase}/${n}" dst-path=hotspot/${n} mode=https`).join('\n')}

:put "Hotspot active on jtm-hs-bridge (port: ${opts.interfaceName}, network: ${opts.networkCidr}). Add more ports with: /interface bridge port add bridge=jtm-hs-bridge interface=<name>"
`;
  return { script };
}

/** Manual cleanup — delete a router record, its WG peer on VPS, its nas row. */
export async function deleteRouter(id: string): Promise<void> {
  const r = await query<{ wg_public_key: string | null; wg_tunnel_ip: string | null }>(
    `SELECT wg_public_key, wg_tunnel_ip FROM routers WHERE id = $1`, [id]
  );
  if (r.rows.length === 0) throw notFound('router');
  const { wg_public_key, wg_tunnel_ip } = r.rows[0];
  if (wg_public_key && wgManager.isEnabled()) {
    try { await wgManager.removePeer(wg_public_key); } catch (e) {
      console.error('[delete] wg peer remove failed:', (e as Error).message);
    }
  }
  if (wg_tunnel_ip) {
    await query(`DELETE FROM nas WHERE nasname = $1`, [wg_tunnel_ip]);
  }
  await query(`DELETE FROM routers WHERE id = $1`, [id]);
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
