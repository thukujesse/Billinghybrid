// =====================================================================
// Auto-import of a live MikroTik's existing clients into JTM billing.
// Reads the router's PPPoE secrets over the tunnel (SSH), pairs each with
// its profile's rate-limit and current online state, and creates matching
// JTM customers + pppoe services. Reuses createCustomer/createService so the
// normal RADIUS sync happens (radcheck/radreply written) — but SILENTLY, so
// importing hundreds of EXISTING customers never blasts onboarding SMS.
//
// Idempotent: a username already present as a JTM service is skipped, so a
// re-run only picks up what's new. "Live clients" = enabled secrets only.
// =====================================================================
import { query } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { execOnRouter, getRouter } from './service.js';
import { createCustomer, createService } from '../customers/service.js';

// Field delimiter for the RouterOS `:put` lines — a sequence that won't occur
// in a PPP username/password/profile/rate-limit or (realistically) a comment.
const DELIM = '~|~';

export interface MikrotikClient {
  username: string;
  password: string;
  profile: string;
  rateLimit: string;      // from the secret's PPP profile (e.g. "10M/20M")
  remoteAddress: string;  // static IP, if the secret pins one
  comment: string;
  online: boolean;        // currently in /ppp active
  imported: boolean;      // already exists as a JTM service (username match)
}

/** Read enabled PPPoE secrets (+ profile rate-limits + who's online). */
export async function readMikrotikClients(routerId: string): Promise<MikrotikClient[]> {
  // Single-line statements — RouterOS over SSH drops reflowed foreach blocks.
  const script = [
    `:foreach s in=[/ppp secret find] do={ :put ("SECRET:" . [/ppp secret get $s name] . "${DELIM}" . [/ppp secret get $s password] . "${DELIM}" . [/ppp secret get $s profile] . "${DELIM}" . [/ppp secret get $s remote-address] . "${DELIM}" . [/ppp secret get $s disabled] . "${DELIM}" . [/ppp secret get $s comment]) }`,
    `:foreach p in=[/ppp profile find] do={ :put ("PROFILE:" . [/ppp profile get $p name] . "${DELIM}" . [/ppp profile get $p rate-limit]) }`,
    `:foreach a in=[/ppp active find] do={ :put ("ACTIVE:" . [/ppp active get $a name]) }`,
  ].join('\n');

  const res = await execOnRouter(routerId, script);
  if (res.returncode !== 0) {
    throw badRequest(`read clients failed: ${res.stderr.trim() || res.stdout.trim() || 'no output'}`);
  }
  const out = res.stdout;

  const profileRate = new Map<string, string>();
  for (const m of out.matchAll(/^PROFILE:(.*)$/gm)) {
    const [name, rate] = m[1].split(DELIM);
    if (name) profileRate.set(name.trim(), (rate ?? '').trim());
  }
  const online = new Set<string>();
  for (const m of out.matchAll(/^ACTIVE:(.*)$/gm)) online.add(m[1].trim());

  const clients: MikrotikClient[] = [];
  for (const m of out.matchAll(/^SECRET:(.*)$/gm)) {
    const parts = m[1].split(DELIM);
    const username = (parts[0] ?? '').trim();
    if (!username) continue;
    if ((parts[4] ?? '').trim() === 'true') continue; // skip disabled secrets
    const profile = (parts[2] ?? '').trim();
    clients.push({
      username,
      password: (parts[1] ?? '').trim(),
      profile,
      rateLimit: profileRate.get(profile) ?? '',
      remoteAddress: (parts[3] ?? '').trim(),
      comment: (parts[5] ?? '').trim(),
      online: online.has(username),
      imported: false,
    });
  }

  // Flag which usernames already exist as JTM services (preview + idempotency).
  if (clients.length) {
    const ex = await query<{ username: string }>(
      `SELECT username FROM services WHERE username = ANY($1)`,
      [clients.map((c) => c.username)]
    );
    const have = new Set(ex.rows.map((r) => r.username));
    for (const c of clients) c.imported = have.has(c.username);
  }
  return clients;
}

export interface ImportResult {
  imported: Array<{ username: string; customerId: string; serviceId: string }>;
  skipped: Array<{ username: string; reason: string }>;
  failed: Array<{ username: string; error: string }>;
}

/** Pull a name + Kenyan phone out of the secret's comment, a common place
 *  ISPs stash the customer identity ("John Doe 0712345678"). Falls back to
 *  the username when the comment has no usable name. */
function parseComment(comment: string, fallbackName: string): { name: string; phone?: string } {
  const match = comment.match(/(?:\+?254|0)\d{9}\b/);
  let phone: string | undefined;
  if (match) {
    const digits = match[0].replace(/\D/g, '');
    phone = digits.startsWith('254') ? digits
      : digits.startsWith('0') ? '254' + digits.slice(1)
      : digits;
  }
  const name = comment.replace(/(?:\+?254|0)\d{9}\b/, '').replace(/[|,]/g, ' ').replace(/\s+/g, ' ').trim();
  return { name: name || fallbackName, phone };
}

/** Import selected (or all) enabled secrets as JTM customers + pppoe services. */
export async function importMikrotikClients(
  routerId: string,
  opts?: { usernames?: string[] }
): Promise<ImportResult> {
  const router = await getRouter(routerId);
  const all = await readMikrotikClients(routerId);
  const pick = opts?.usernames?.length ? new Set(opts.usernames) : null;
  const targets = pick ? all.filter((c) => pick.has(c.username)) : all;

  const result: ImportResult = { imported: [], skipped: [], failed: [] };
  for (const c of targets) {
    try {
      if (c.imported) { result.skipped.push({ username: c.username, reason: 'already imported' }); continue; }
      // Re-check live (guards a race with a concurrent import / the unique index).
      const dup = await query(`SELECT 1 FROM services WHERE username=$1 LIMIT 1`, [c.username]);
      if (dup.rowCount) { result.skipped.push({ username: c.username, reason: 'already imported' }); continue; }
      if (!c.password) { result.skipped.push({ username: c.username, reason: 'secret has no password' }); continue; }

      const { name, phone } = parseComment(c.comment, c.username);
      const customer = await createCustomer({
        full_name: name,
        phone,
        notes: `Imported from ${router.name}${c.profile ? ` (PPPoE profile "${c.profile}")` : ''}`,
      });
      const service = await createService({
        customer_id: customer.id,
        service_type: 'pppoe',
        username: c.username,
        password: c.password,
        router_id: routerId,
        rate_limit: c.rateLimit || undefined,
        silent: true, // existing customers — don't SMS/charge them onboarding
      });
      result.imported.push({ username: c.username, customerId: customer.id, serviceId: service.id });
    } catch (e) {
      result.failed.push({ username: c.username, error: (e as Error).message });
    }
  }
  return result;
}
