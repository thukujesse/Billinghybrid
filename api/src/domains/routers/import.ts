// =====================================================================
// Auto-import of a live MikroTik's existing clients into JTM billing.
// Reads the router's PPPoE secrets, hotspot users and static DHCP leases
// over the tunnel (SSH) and creates matching JTM customers + services,
// reusing createCustomer/createService so the normal RADIUS sync happens
// (radcheck/radreply written for pppoe/hotspot; static enforced via the
// MikroTik API, not RADIUS) — but SILENTLY, so importing hundreds of
// EXISTING customers never blasts onboarding SMS.
//
// PPPoE imports can be mapped profile -> JTM plan, which makes them billable
// (rate-limit + expiry derived from the plan) instead of a raw rate string.
//
// Idempotent: usernames/IPs already present as a JTM service are skipped, so
// a re-run only picks up what's new. "Live clients" = enabled accounts only.
// =====================================================================
import { query } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { execOnRouter, getRouter } from './service.js';
import { createCustomer, createService } from '../customers/service.js';

// Field delimiter for the RouterOS `:put` lines — a sequence that won't occur
// in a name/password/profile/rate-limit/IP or (realistically) a comment.
const DELIM = '~|~';

export interface PppoeClient {
  username: string; password: string; profile: string; rateLimit: string;
  remoteAddress: string; comment: string; online: boolean; imported: boolean;
}
export interface HotspotUser {
  username: string; password: string; profile: string; comment: string; imported: boolean;
}
export interface StaticLease {
  address: string; macAddress: string; hostName: string; comment: string; imported: boolean;
}
export interface RouterClients {
  pppoe: PppoeClient[];
  hotspot: HotspotUser[];
  staticLeases: StaticLease[];
  pppoeProfiles: string[]; // distinct profiles among the pppoe secrets (for plan mapping)
}

/** Read enabled PPPoE secrets, hotspot users and static DHCP leases. */
export async function readMikrotikClients(routerId: string): Promise<RouterClients> {
  // Single-line statements — RouterOS over SSH drops reflowed foreach blocks.
  const script = [
    `:foreach s in=[/ppp secret find] do={ :put ("SECRET:" . [/ppp secret get $s name] . "${DELIM}" . [/ppp secret get $s password] . "${DELIM}" . [/ppp secret get $s profile] . "${DELIM}" . [/ppp secret get $s remote-address] . "${DELIM}" . [/ppp secret get $s disabled] . "${DELIM}" . [/ppp secret get $s comment]) }`,
    `:foreach p in=[/ppp profile find] do={ :put ("PROFILE:" . [/ppp profile get $p name] . "${DELIM}" . [/ppp profile get $p rate-limit]) }`,
    `:foreach a in=[/ppp active find] do={ :put ("ACTIVE:" . [/ppp active get $a name]) }`,
    `:foreach u in=[/ip hotspot user find] do={ :put ("HSUSER:" . [/ip hotspot user get $u name] . "${DELIM}" . [/ip hotspot user get $u password] . "${DELIM}" . [/ip hotspot user get $u profile] . "${DELIM}" . [/ip hotspot user get $u disabled] . "${DELIM}" . [/ip hotspot user get $u comment]) }`,
    `:foreach l in=[/ip dhcp-server lease find] do={ :put ("LEASE:" . [/ip dhcp-server lease get $l address] . "${DELIM}" . [/ip dhcp-server lease get $l mac-address] . "${DELIM}" . [/ip dhcp-server lease get $l host-name] . "${DELIM}" . [/ip dhcp-server lease get $l dynamic] . "${DELIM}" . [/ip dhcp-server lease get $l comment]) }`,
  ].join('\n');

  const res = await execOnRouter(routerId, script);
  if (res.returncode !== 0) {
    throw badRequest(`read clients failed: ${res.stderr.trim() || res.stdout.trim() || 'no output'}`);
  }
  const out = res.stdout;
  const fields = (line: string) => line.split(DELIM).map((f) => f.trim());
  const isTrue = (v: string) => v === 'true' || v === 'yes';

  const profileRate = new Map<string, string>();
  for (const m of out.matchAll(/^PROFILE:(.*)$/gm)) {
    const [name, rate] = fields(m[1]);
    if (name) profileRate.set(name, rate ?? '');
  }
  const online = new Set<string>();
  for (const m of out.matchAll(/^ACTIVE:(.*)$/gm)) online.add(m[1].trim());

  const pppoe: PppoeClient[] = [];
  for (const m of out.matchAll(/^SECRET:(.*)$/gm)) {
    const [username, password, profile, remoteAddress, disabled, comment] = fields(m[1]);
    if (!username || isTrue(disabled)) continue; // enabled secrets only
    pppoe.push({
      username, password: password ?? '', profile: profile ?? '',
      rateLimit: profileRate.get(profile ?? '') ?? '',
      remoteAddress: remoteAddress ?? '', comment: comment ?? '',
      online: online.has(username), imported: false,
    });
  }

  const hotspot: HotspotUser[] = [];
  for (const m of out.matchAll(/^HSUSER:(.*)$/gm)) {
    const [username, password, profile, disabled, comment] = fields(m[1]);
    if (!username || isTrue(disabled)) continue;
    hotspot.push({ username, password: password ?? '', profile: profile ?? '', comment: comment ?? '', imported: false });
  }

  const staticLeases: StaticLease[] = [];
  for (const m of out.matchAll(/^LEASE:(.*)$/gm)) {
    const [address, macAddress, hostName, dynamic, comment] = fields(m[1]);
    if (!address || isTrue(dynamic)) continue; // static (reserved) leases only
    staticLeases.push({ address, macAddress: macAddress ?? '', hostName: hostName ?? '', comment: comment ?? '', imported: false });
  }

  // Flag which already exist as JTM services (preview + idempotency).
  const usernames = [...pppoe.map((c) => c.username), ...hotspot.map((c) => c.username)];
  if (usernames.length) {
    const ex = await query<{ username: string }>(`SELECT username FROM services WHERE username = ANY($1)`, [usernames]);
    const have = new Set(ex.rows.map((r) => r.username));
    for (const c of pppoe) c.imported = have.has(c.username);
    for (const c of hotspot) c.imported = have.has(c.username);
  }
  if (staticLeases.length) {
    const ex = await query<{ ip_address: string }>(
      `SELECT ip_address FROM services WHERE service_type='static' AND ip_address = ANY($1)`,
      [staticLeases.map((l) => l.address)]
    );
    const have = new Set(ex.rows.map((r) => r.ip_address));
    for (const l of staticLeases) l.imported = have.has(l.address);
  }

  const pppoeProfiles = [...new Set(pppoe.map((c) => c.profile).filter(Boolean))];
  return { pppoe, hotspot, staticLeases, pppoeProfiles };
}

export interface ImportResult {
  imported: Array<{ kind: string; ref: string }>;
  skipped: Array<{ kind: string; ref: string; reason: string }>;
  failed: Array<{ kind: string; ref: string; error: string }>;
}

export interface ImportSelection {
  pppoe?: string[];        // usernames
  hotspot?: string[];      // usernames
  staticLeases?: string[]; // lease addresses
  planByProfile?: Record<string, string>; // pppoe profile -> plan_id (makes the import billable)
}

/** Pull a name + Kenyan phone out of a comment, a common place ISPs stash the
 *  customer identity ("John Doe 0712345678"). Falls back to `fallback`. */
function parseComment(comment: string, fallback: string): { name: string; phone?: string } {
  const match = comment.match(/(?:\+?254|0)\d{9}\b/);
  let phone: string | undefined;
  if (match) {
    const digits = match[0].replace(/\D/g, '');
    phone = digits.startsWith('254') ? digits : digits.startsWith('0') ? '254' + digits.slice(1) : digits;
  }
  const name = comment.replace(/(?:\+?254|0)\d{9}\b/, '').replace(/[|,]/g, ' ').replace(/\s+/g, ' ').trim();
  return { name: name || fallback, phone };
}

async function usernameTaken(username: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM services WHERE username=$1 LIMIT 1`, [username]);
  return !!r.rowCount;
}

/** Import selected clients as JTM customers + services. */
export async function importMikrotikClients(routerId: string, sel: ImportSelection = {}): Promise<ImportResult> {
  const router = await getRouter(routerId);
  const all = await readMikrotikClients(routerId);
  const result: ImportResult = { imported: [], skipped: [], failed: [] };
  const planFor = (profile: string) => sel.planByProfile?.[profile];

  // ---- PPPoE ----
  const pppoePick = sel.pppoe?.length ? new Set(sel.pppoe) : null;
  for (const c of all.pppoe.filter((x) => (pppoePick ? pppoePick.has(x.username) : true))) {
    try {
      if (c.imported || (await usernameTaken(c.username))) { result.skipped.push({ kind: 'pppoe', ref: c.username, reason: 'already imported' }); continue; }
      if (!c.password) { result.skipped.push({ kind: 'pppoe', ref: c.username, reason: 'secret has no password' }); continue; }
      const { name, phone } = parseComment(c.comment, c.username);
      const planId = planFor(c.profile);
      const customer = await createCustomer({ full_name: name, phone, notes: `Imported from ${router.name}${c.profile ? ` (PPPoE profile "${c.profile}")` : ''}` });
      await createService({
        customer_id: customer.id, service_type: 'pppoe', username: c.username, password: c.password,
        router_id: routerId, plan_id: planId,
        rate_limit: planId ? undefined : (c.rateLimit || undefined), // plan derives rate when mapped
        silent: true,
      });
      result.imported.push({ kind: 'pppoe', ref: c.username });
    } catch (e) { result.failed.push({ kind: 'pppoe', ref: c.username, error: (e as Error).message }); }
  }

  // ---- Hotspot users ----
  const hsPick = sel.hotspot?.length ? new Set(sel.hotspot) : null;
  for (const c of all.hotspot.filter((x) => (hsPick ? hsPick.has(x.username) : true))) {
    try {
      if (c.imported || (await usernameTaken(c.username))) { result.skipped.push({ kind: 'hotspot', ref: c.username, reason: 'already imported' }); continue; }
      if (!c.password) { result.skipped.push({ kind: 'hotspot', ref: c.username, reason: 'user has no password (MAC/voucher)' }); continue; }
      const { name, phone } = parseComment(c.comment, c.username);
      const customer = await createCustomer({ full_name: name, phone, notes: `Imported from ${router.name} (hotspot user)` });
      await createService({ customer_id: customer.id, service_type: 'hotspot', username: c.username, password: c.password, router_id: routerId, silent: true });
      result.imported.push({ kind: 'hotspot', ref: c.username });
    } catch (e) { result.failed.push({ kind: 'hotspot', ref: c.username, error: (e as Error).message }); }
  }

  // ---- Static DHCP leases ----
  const stPick = sel.staticLeases?.length ? new Set(sel.staticLeases) : null;
  for (const l of all.staticLeases.filter((x) => (stPick ? stPick.has(x.address) : true))) {
    try {
      if (l.imported) { result.skipped.push({ kind: 'static', ref: l.address, reason: 'already imported' }); continue; }
      const dup = await query(`SELECT 1 FROM services WHERE service_type='static' AND ip_address=$1 LIMIT 1`, [l.address]);
      if (dup.rowCount) { result.skipped.push({ kind: 'static', ref: l.address, reason: 'already imported' }); continue; }
      const { name, phone } = parseComment(l.comment || l.hostName, l.hostName || l.address);
      const customer = await createCustomer({ full_name: name, phone, notes: `Imported from ${router.name} (static lease ${l.address})` });
      await createService({ customer_id: customer.id, service_type: 'static', ip_address: l.address, mac_address: l.macAddress || undefined, router_id: routerId, silent: true });
      result.imported.push({ kind: 'static', ref: l.address });
    } catch (e) { result.failed.push({ kind: 'static', ref: l.address, error: (e as Error).message }); }
  }

  return result;
}
