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

export async function addPeer(publicKey: string, tunnelIp: string): Promise<void> {
  const r = await fetch(`${config.wireguard.managerUrl}/peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ publicKey, tunnelIp }),
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
    body: JSON.stringify({ command, sshPort: opts.sshPort, user: opts.user }),
  });
  const body = (await r.json()) as ExecResult & { error?: string };
  if (!r.ok && r.status !== 502) {
    throw new Error(`wg-manager exec failed (${r.status}): ${body.error ?? 'unknown'}`);
  }
  return body;
}
