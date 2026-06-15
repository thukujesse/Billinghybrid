import { execFile } from 'node:child_process';
import { query } from '../../db/pool.js';

/**
 * RADIUS CoA / Disconnect dispatcher (RFC 5176). FreeRADIUS + the app run on the
 * VPS; each MikroTik NAS has `/radius incoming accept=yes` and is reachable over
 * the WireGuard tunnel on UDP 3799. We send a Disconnect-Request via `radclient`
 * (freeradius-utils) using the per-NAS shared secret, matching the live session
 * by User-Name / Calling-Station-Id / Acct-Session-Id.
 *
 * This is what makes "suspend = instant kick" and "pay = online in <10s" work
 * (force the device to re-auth and pick up its new FreeRADIUS decision), instead
 * of waiting for the next interim-update / re-association.
 */

const COA_PORT = 3799;

export interface DisconnectAttrs {
  'User-Name'?: string;
  'Acct-Session-Id'?: string;
  'Framed-IP-Address'?: string;
  'Calling-Station-Id'?: string;
}

export interface DisconnectResult { ok: boolean; nasIp: string; output: string }

/** Send one Disconnect-Request to a NAS. Resolves (never rejects) so callers
 *  can fire-and-forget; success = the NAS returned Disconnect-ACK. */
export function sendDisconnect(nasIp: string, secret: string, attrs: DisconnectAttrs): Promise<DisconnectResult> {
  const pairs = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}=${v}`);
  // NAS-IP-Address helps some implementations route the request to the session.
  pairs.push(`NAS-IP-Address=${nasIp}`);
  const body = pairs.join(',') + '\n';

  return new Promise((resolve) => {
    const child = execFile(
      'radclient',
      ['-t', '3', '-r', '1', `${nasIp}:${COA_PORT}`, 'disconnect', secret],
      { timeout: 8000 },
      (_err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`;
        resolve({ ok: /Disconnect-ACK/i.test(out), nasIp, output: out.trim().slice(0, 500) });
      }
    );
    try { child.stdin?.write(body); child.stdin?.end(); } catch { /* child already gone */ }
  });
}

/** Look up a NAS's shared secret by its tunnel IP (= radacct.nasipaddress). */
async function nasSecret(nasIp: string): Promise<string | null> {
  const r = await query<{ radius_secret: string | null }>(
    `SELECT radius_secret FROM routers WHERE wg_tunnel_ip = $1`, [nasIp]
  );
  return r.rows[0]?.radius_secret ?? null;
}

interface LiveSession { nasipaddress: string; username: string; acctsessionid: string; callingstationid: string | null; framedipaddress: string | null }

async function liveSessions(field: 'username' | 'callingstationid', value: string): Promise<LiveSession[]> {
  // MAC (callingstationid) case/format varies by NAS, so match case-insensitively;
  // username is exact.
  const cond = field === 'callingstationid'
    ? `replace(upper(callingstationid),'-',':') = replace(upper($1),'-',':')`
    : `username = $1`;
  const r = await query<LiveSession>(
    `SELECT nasipaddress, username, acctsessionid, callingstationid, framedipaddress
       FROM radacct
      WHERE ${cond} AND acctstoptime IS NULL`,
    [value]
  );
  return r.rows;
}

/** Disconnect every live session for a username (e.g. a suspended PPPoE customer). */
export async function kickByUsername(username: string): Promise<DisconnectResult[]> {
  const sessions = await liveSessions('username', username);
  return kickSessions(sessions);
}

/** Disconnect every live session for a MAC (Calling-Station-Id) — per-device. */
export async function kickByMac(mac: string): Promise<DisconnectResult[]> {
  const sessions = await liveSessions('callingstationid', mac);
  return kickSessions(sessions);
}

async function kickSessions(sessions: LiveSession[]): Promise<DisconnectResult[]> {
  const out: DisconnectResult[] = [];
  for (const s of sessions) {
    const secret = await nasSecret(s.nasipaddress);
    if (!secret) {
      out.push({ ok: false, nasIp: s.nasipaddress, output: 'no NAS secret on file' });
      continue;
    }
    const r = await sendDisconnect(s.nasipaddress, secret, {
      'User-Name': s.username,
      'Acct-Session-Id': s.acctsessionid,
      'Framed-IP-Address': s.framedipaddress ?? undefined,
      'Calling-Station-Id': s.callingstationid ?? undefined,
    });
    console.log(`[coa] disconnect ${s.username}@${s.nasipaddress} -> ${r.ok ? 'ACK' : 'no-ack'}`);
    out.push(r);
  }
  return out;
}
