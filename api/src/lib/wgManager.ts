import { config } from '../config.js';

export interface VpsPeer {
  publicKey: string;
  endpoint: string | null;
  allowedIps: string;
  latestHandshake: number | null;
  transferRx: number;
  transferTx: number;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${config.wireguard.managerToken}` };
}

export function isEnabled(): boolean {
  return !!config.wireguard.managerToken;
}

export async function addPeer(
  publicKey: string,
  tunnelIp: string,
  radiusSecret?: string,
  name?: string
): Promise<void> {
  // Option B: this VPS owns its local RADIUS DB. Pass the per-router RADIUS
  // secret so wg-manager registers the `nas` row in the VPS-local DB (and
  // reloads FreeRADIUS) — otherwise the NAS lands only in the dashboard's
  // remote DB and the FreeRADIUS that actually serves the router never
  // trusts it.
  const r = await fetch(`${config.wireguard.managerUrl}/peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ publicKey, tunnelIp, radiusSecret, name }),
  });
  if (!r.ok) {
    throw new Error(`wg-manager add failed (${r.status}): ${await r.text()}`);
  }
}

export async function removePeer(publicKey: string): Promise<void> {
  const r = await fetch(
    `${config.wireguard.managerUrl}/peers/${encodeURIComponent(publicKey)}`,
    { method: 'DELETE', headers: authHeader() }
  );
  if (!r.ok && r.status !== 404) {
    throw new Error(`wg-manager remove failed (${r.status}): ${await r.text()}`);
  }
}

/**
 * Tell wg-manager to restart freeradius so it re-reads the `nas` client table
 * (needed after we INSERT/UPDATE/DELETE on `nas` — otherwise FreeRADIUS keeps
 * the old shared secret cached and silently drops new requests). Fire-and-
 * forget — failure here shouldn't break the calling operation.
 */
export async function reloadFreeRadius(): Promise<void> {
  if (!isEnabled()) return;
  try {
    const r = await fetch(`${config.wireguard.managerUrl}/freeradius/reload`, {
      method: 'POST',
      headers: authHeader(),
    });
    if (!r.ok) {
      console.error('[freeradius] reload non-ok:', r.status, await r.text());
    }
  } catch (err) {
    console.error('[freeradius] reload error:', (err as Error).message);
  }
}

export async function listPeers(): Promise<VpsPeer[]> {
  const r = await fetch(`${config.wireguard.managerUrl}/peers`, { headers: authHeader() });
  if (!r.ok) throw new Error(`wg-manager list failed (${r.status})`);
  const j = (await r.json()) as { peers: VpsPeer[] };
  return j.peers;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

/**
 * Ask wg-manager to SSH into the MikroTik at `tunnelIp` (over the WG tunnel)
 * and run `command`. SSH auth is by key — the MikroTik trusts wg-manager's
 * public key via the provisioning script.
 */
export async function execOnRouter(
  tunnelIp: string,
  command: string,
  opts: { sshPort?: number; user?: string } = {}
): Promise<ExecResult> {
  const r = await fetch(`${config.wireguard.managerUrl}/routers/${tunnelIp}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({
      command,
      sshPort: opts.sshPort,
      user: opts.user ?? 'hub-mgmt',
    }),
  });
  const body = (await r.json()) as ExecResult & { error?: string };
  if (!r.ok && r.status !== 502) {
    throw new Error(`wg-manager exec failed (${r.status}): ${body.error ?? 'unknown'}`);
  }
  return body;
}

/**
 * Deliver a multi-line RouterOS script to the MikroTik as a FILE (scp over the
 * tunnel) and /import it. RouterOS mangles multi-line scripts piped inline over
 * SSH ("expected end of command, line 1"); importing a file parses correctly.
 */
export async function importScript(
  tunnelIp: string,
  script: string,
  opts: { sshPort?: number; user?: string } = {}
): Promise<ExecResult> {
  const r = await fetch(`${config.wireguard.managerUrl}/routers/${tunnelIp}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({
      script,
      sshPort: opts.sshPort,
      user: opts.user ?? 'hub-mgmt',
    }),
  });
  const body = (await r.json()) as ExecResult & { error?: string };
  if (!r.ok && r.status !== 502) {
    throw new Error(`wg-manager import failed (${r.status}): ${body.error ?? 'unknown'}`);
  }
  return body;
}

/**
 * Probe SSH ports (22, 21, 2222, 8022) for one that accepts our hub-mgmt key
 * auth. Returns the working port or null if none respond.
 */
export async function probeSshPort(
  tunnelIp: string,
  user = 'hub-mgmt'
): Promise<number | null> {
  const r = await fetch(
    `${config.wireguard.managerUrl}/routers/${tunnelIp}/probe-ssh`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ user }),
    }
  );
  if (!r.ok) return null;
  const body = (await r.json()) as { sshPort: number | null };
  return body.sshPort;
}

/**
 * Send a RADIUS CoA Disconnect-Request to the MikroTik that owns the live
 * session, so the user is kicked immediately on suspend (rather than waiting
 * for the next re-authentication interval).
 */
export async function coaDisconnect(input: {
  nasIp: string; sessionId: string; secret: string; username?: string;
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await fetch(`${config.wireguard.managerUrl}/coa/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(input),
  });
  return (await r.json()) as { ok: boolean; stdout: string; stderr: string };
}
