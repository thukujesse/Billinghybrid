import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import * as wgManager from '../../lib/wgManager.js';
import { config } from '../../config.js';
import { notify } from '../notifications/service.js';

export interface Customer {
  id: string;
  account_number: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: 'active' | 'suspended' | 'closed';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Service {
  id: string;
  customer_id: string;
  service_type: 'pppoe' | 'hotspot' | 'static' | 'ftth_gpon';
  username: string | null;
  password: string | null;
  ip_address: string | null;
  mac_address: string | null;
  vlan_id: number | null;
  router_id: string | null;
  plan_id: string | null;
  rate_limit: string | null;
  status: 'active' | 'suspended' | 'expired' | 'cancelled';
  expiry_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerWithServices extends Customer {
  services: Service[];
}

const CUSTOMER_COLS = `id, account_number, full_name, phone, email, address,
  status, notes, created_at, updated_at`;
const SERVICE_COLS = `id, customer_id, service_type, username, password,
  ip_address, mac_address, vlan_id, router_id, plan_id, rate_limit, status,
  expiry_date, created_at, updated_at`;

/**
 * Push a service into the FreeRADIUS tables (radcheck for password,
 * radreply for policy attributes). Suspended/expired services are
 * given Auth-Type := Reject so the RADIUS server actively denies them.
 * Static and FTTH services don't touch RADIUS — their enforcement happens
 * via the MikroTik API (queues, address lists) in Wedge C.
 */
export async function syncServiceToRadius(svc: Service): Promise<void> {
  if (svc.service_type !== 'pppoe' && svc.service_type !== 'hotspot') return;
  if (!svc.username) return;

  await withTransaction(async (client) => {
    await client.query('DELETE FROM radcheck WHERE username = $1', [svc.username]);
    await client.query('DELETE FROM radreply WHERE username = $1', [svc.username]);

    if (svc.status === 'active' && svc.password) {
      await client.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
        [svc.username, 'Cleartext-Password', ':=', svc.password]
      );
      if (svc.rate_limit) {
        await client.query(
          `INSERT INTO radreply (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
          [svc.username, 'Mikrotik-Rate-Limit', '=', svc.rate_limit]
        );
      }
    } else if (svc.service_type === 'pppoe' && svc.password) {
      // PPPoE limp mode (hybrid approach for INSTANT suspend/restore):
      // Keep auth credentials intact (no pool override, no rate downgrade) so
      // we don't need to kick the customer's PPP session — they stay connected
      // continuously. Captive redirect is driven entirely by their framed-IP
      // being in the jtm-expired address-list (push/pull via SSH on status
      // change). The DST-NAT + proxy rules on the MikroTik catch HTTP from
      // that list and 302-redirect to /renew. When restored, removing them
      // from the list is enough — no reconnect needed.
      await client.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
        [svc.username, 'Cleartext-Password', ':=', svc.password]
      );
      if (svc.rate_limit) {
        await client.query(
          `INSERT INTO radreply (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
          [svc.username, 'Mikrotik-Rate-Limit', '=', svc.rate_limit]
        );
      }
    } else {
      // Hotspot or other: hard-reject (hotspot has its own captive portal flow).
      await client.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
        [svc.username, 'Auth-Type', ':=', 'Reject']
      );
    }
  });
}

export interface ServiceSummary extends Pick<Service,
  'id' | 'service_type' | 'username' | 'rate_limit' | 'status' | 'plan_id' | 'expiry_date'> {
  plan_name: string | null;
}

export interface CustomerWithServiceSummary extends Customer {
  services: ServiceSummary[];
}

export async function listCustomers(): Promise<CustomerWithServiceSummary[]> {
  const r = await query<Customer>(
    `SELECT ${CUSTOMER_COLS} FROM customers ORDER BY created_at DESC`
  );
  if (r.rows.length === 0) return [];
  const ids = r.rows.map((c) => c.id);
  const sr = await query<{
    id: string; customer_id: string; service_type: Service['service_type'];
    username: string | null; rate_limit: string | null; status: Service['status'];
    plan_id: string | null; plan_name: string | null; expiry_date: string | null;
  }>(
    `SELECT s.id, s.customer_id, s.service_type, s.username, s.rate_limit, s.status,
            s.plan_id, p.name AS plan_name, s.expiry_date
       FROM services s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.customer_id = ANY($1::uuid[])
      ORDER BY s.created_at`,
    [ids]
  );
  const byCustomer = new Map<string, ServiceSummary[]>();
  for (const s of sr.rows) {
    if (!byCustomer.has(s.customer_id)) byCustomer.set(s.customer_id, []);
    byCustomer.get(s.customer_id)!.push({
      id: s.id, service_type: s.service_type, username: s.username,
      rate_limit: s.rate_limit, status: s.status,
      plan_id: s.plan_id, plan_name: s.plan_name, expiry_date: s.expiry_date,
    });
  }
  return r.rows.map((c) => ({ ...c, services: byCustomer.get(c.id) ?? [] }));
}

export async function getCustomer(id: string): Promise<CustomerWithServices> {
  const cr = await query<Customer>(
    `SELECT ${CUSTOMER_COLS} FROM customers WHERE id = $1`, [id]
  );
  if (!cr.rows[0]) throw notFound('customer');
  const sr = await query<Service>(
    `SELECT ${SERVICE_COLS} FROM services WHERE customer_id = $1 ORDER BY created_at`, [id]
  );
  return { ...cr.rows[0], services: sr.rows };
}

export async function createCustomer(input: {
  account_number?: string;
  full_name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}): Promise<Customer> {
  // Auto-generate account number if not supplied: HUB + 6-digit sequence.
  const accountNumber = input.account_number ?? (await nextAccountNumber());
  const r = await query<Customer>(
    `INSERT INTO customers (account_number, full_name, phone, email, address, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${CUSTOMER_COLS}`,
    [accountNumber, input.full_name, input.phone ?? null, input.email ?? null,
     input.address ?? null, input.notes ?? null]
  );
  return r.rows[0];
}

/**
 * Edit customer-level fields. Only the supplied keys are touched — undefined
 * means "leave as-is". Returns the full row so the caller can show the
 * after-state without an extra round-trip.
 */
export async function updateCustomer(id: string, fields: {
  full_name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  status?: 'active' | 'suspended' | 'closed';
}): Promise<Customer> {
  const sets: string[] = [];
  const vals: any[] = [];
  const addField = (col: string, val: unknown) => {
    if (val !== undefined) { vals.push(val); sets.push(`${col} = $${vals.length}`); }
  };
  addField('full_name', fields.full_name);
  addField('phone', fields.phone);
  addField('email', fields.email);
  addField('address', fields.address);
  addField('notes', fields.notes);
  addField('status', fields.status);
  if (sets.length === 0) {
    const r = await query<Customer>(`SELECT ${CUSTOMER_COLS} FROM customers WHERE id = $1`, [id]);
    if (!r.rows[0]) throw notFound('customer');
    return r.rows[0];
  }
  sets.push(`updated_at = now()`);
  vals.push(id);
  const r = await query<Customer>(
    `UPDATE customers SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING ${CUSTOMER_COLS}`,
    vals
  );
  if (!r.rows[0]) throw notFound('customer');
  return r.rows[0];
}

export interface CustomerPayment {
  id: string;
  source: 'hotspot_renewal' | 'hotspot_guest';
  checkout_request_id: string | null;
  amount_kes: number;
  status: 'pending' | 'success' | 'failed' | 'expired';
  receipt: string | null;
  failure_reason: string | null;
  service_id: string | null;
  service_username: string | null;
  plan_id: string | null;
  plan_name: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * Payment history for a customer — currently sourced from hotspot_purchases
 * (M-Pesa STK pushes). 'hotspot_renewal' rows have service_id set and were
 * the PPPoE-restore payments; we surface 'hotspot_guest' too if the phone
 * matches the customer's phone (defensive — operator might want to see
 * all M-Pesa activity for that phone number).
 */
export async function getCustomerPayments(customerId: string, limit = 50): Promise<CustomerPayment[]> {
  const c = await query<{ phone: string | null }>(
    `SELECT phone FROM customers WHERE id = $1`, [customerId]
  );
  if (!c.rows[0]) throw notFound('customer');

  // Two paths joined: payments linked via service_id (the strong link), and
  // payments where only phone matches (weak link — could include unrelated
  // guest purchases from someone using the same number, but operator finds
  // that useful for reconciliation).
  const r = await query<CustomerPayment>(
    `SELECT DISTINCT ON (hp.id)
            hp.id,
            CASE WHEN hp.service_id IS NOT NULL THEN 'hotspot_renewal' ELSE 'hotspot_guest' END AS source,
            hp.checkout_request_id,
            hp.amount_kes,
            hp.status,
            hp.receipt,
            hp.failure_reason,
            hp.service_id,
            s.username AS service_username,
            hp.plan_id,
            p.name AS plan_name,
            hp.created_at,
            hp.completed_at
       FROM hotspot_purchases hp
       LEFT JOIN services s ON s.id = hp.service_id
       LEFT JOIN plans p ON p.id = hp.plan_id
      WHERE hp.service_id IN (SELECT id FROM services WHERE customer_id = $1)
         OR (hp.phone = $2 AND $2 IS NOT NULL)
      ORDER BY hp.id, hp.created_at DESC
      LIMIT $3`,
    [customerId, c.rows[0].phone ?? '', limit]
  );
  // Re-sort by created_at after the DISTINCT ON (which forced ordering by id).
  return r.rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export interface ServiceSession {
  acctsessionid: string;
  acctstarttime: string | null;
  acctstoptime: string | null;
  framed_ip: string | null;
  nas_ip: string | null;
  acctinputoctets: string;        // bigint as string — Postgres numeric
  acctoutputoctets: string;
  acctterminatecause: string | null;
}

/** Recent radacct sessions for a service — last N by start time. */
export async function getRecentSessions(serviceId: string, limit = 20): Promise<ServiceSession[]> {
  const sr = await query<{ username: string | null }>(
    `SELECT username FROM services WHERE id = $1`, [serviceId]
  );
  if (!sr.rows[0]) throw notFound('service');
  const username = sr.rows[0].username;
  if (!username) return [];

  const r = await query<ServiceSession>(
    `SELECT acctsessionid,
            acctstarttime, acctstoptime,
            host(framedipaddress) AS framed_ip,
            host(nasipaddress) AS nas_ip,
            COALESCE(acctinputoctets, 0)::text AS acctinputoctets,
            COALESCE(acctoutputoctets, 0)::text AS acctoutputoctets,
            acctterminatecause
       FROM radacct
      WHERE username = $1
      ORDER BY acctstarttime DESC NULLS LAST
      LIMIT $2`,
    [username, limit]
  );
  return r.rows;
}

async function nextAccountNumber(): Promise<string> {
  const r = await query<{ count: string }>(
    `SELECT count(*)::text FROM customers WHERE account_number LIKE 'HUB%'`
  );
  const n = parseInt(r.rows[0].count, 10) + 1;
  return `HUB${String(n).padStart(6, '0')}`;
}

export async function createService(input: {
  customer_id: string;
  service_type: Service['service_type'];
  username?: string;
  password?: string;
  ip_address?: string;
  mac_address?: string;
  vlan_id?: number;
  router_id?: string;
  plan_id?: string;
  rate_limit?: string;
  expiry_date?: string;
}): Promise<Service> {
  // Validate customer exists.
  await getCustomer(input.customer_id);

  if ((input.service_type === 'pppoe' || input.service_type === 'hotspot')
      && (!input.username || !input.password)) {
    throw badRequest('username and password required for pppoe/hotspot services');
  }
  if (input.service_type === 'static' && !input.ip_address) {
    throw badRequest('ip_address required for static services');
  }

  // Plan-driven provisioning: when a plan_id is supplied, derive the
  // rate-limit string and the expiry_date from the plan rather than
  // making the operator type them. Explicit fields in the input still
  // win — the plan only fills gaps.
  let rateLimit = input.rate_limit ?? null;
  let expiryDate = input.expiry_date ?? null;
  if (input.plan_id) {
    const p = await query<{
      speed_down_kbps: number | null; speed_up_kbps: number | null; validity_days: number;
    }>(
      `SELECT speed_down_kbps, speed_up_kbps, validity_days FROM plans WHERE id = $1 AND active = TRUE`,
      [input.plan_id]
    );
    const plan = p.rows[0];
    if (!plan) throw notFound('plan');
    if (!rateLimit && plan.speed_down_kbps && plan.speed_up_kbps) {
      rateLimit = `${plan.speed_up_kbps}k/${plan.speed_down_kbps}k`;
    }
    if (!expiryDate) {
      const d = new Date();
      d.setDate(d.getDate() + plan.validity_days);
      expiryDate = d.toISOString();
    }
  }

  const r = await query<Service>(
    `INSERT INTO services
       (customer_id, service_type, username, password, ip_address, mac_address,
        vlan_id, router_id, plan_id, rate_limit, expiry_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${SERVICE_COLS}`,
    [input.customer_id, input.service_type, input.username ?? null,
     input.password ?? null, input.ip_address ?? null, input.mac_address ?? null,
     input.vlan_id ?? null, input.router_id ?? null, input.plan_id ?? null,
     rateLimit, expiryDate]
  );
  const service = r.rows[0];
  await syncServiceToRadius(service);
  return service;
}

/**
 * Force-renew a service without going through M-Pesa. Bumps expiry by
 * the plan's validity_days, restores status to 'active', re-syncs RADIUS.
 * Used by operators for manual top-ups (cash payments, comps, fixes).
 * If `planId` is omitted, uses the service's existing plan_id.
 */
export async function renewService(input: {
  serviceId: string;
  planId?: string;
  fromNow?: boolean;        // true = expiry = now + validity (default); false = expiry += validity
}): Promise<Service> {
  const r = await query<Service & { plan_id: string | null }>(
    `SELECT ${SERVICE_COLS} FROM services WHERE id = $1`, [input.serviceId]
  );
  const svc = r.rows[0];
  if (!svc) throw notFound('service');

  const planId = input.planId ?? svc.plan_id;
  if (!planId) throw badRequest('no plan_id on service — supply planId or set one first');

  const pr = await query<{
    speed_down_kbps: number | null; speed_up_kbps: number | null; validity_days: number;
  }>(
    `SELECT speed_down_kbps, speed_up_kbps, validity_days FROM plans WHERE id = $1 AND active = TRUE`,
    [planId]
  );
  const plan = pr.rows[0];
  if (!plan) throw notFound('plan');

  // Stack-or-restart policy: if the service is still live and the operator
  // says fromNow=false, extend from current expiry. Otherwise start the
  // window now (covers reactivating after expiry / cancellation).
  const base = (!input.fromNow && svc.expiry_date && new Date(svc.expiry_date) > new Date())
    ? new Date(svc.expiry_date)
    : new Date();
  const newExpiry = new Date(base);
  newExpiry.setDate(newExpiry.getDate() + plan.validity_days);

  const rateLimit = (plan.speed_down_kbps && plan.speed_up_kbps)
    ? `${plan.speed_up_kbps}k/${plan.speed_down_kbps}k`
    : svc.rate_limit;

  // setServiceStatus does the RADIUS sync + jtm-expired removal for us when
  // status transitions back to active, so update fields first then route
  // through it for the side-effects. expiry_warned_at is cleared so the
  // proactive "expires soon" SMS fires again as the new expiry approaches.
  await query(
    `UPDATE services
        SET plan_id = $2, rate_limit = $3, expiry_date = $4,
            expiry_warned_at = NULL, updated_at = now()
      WHERE id = $1`,
    [input.serviceId, planId, rateLimit, newExpiry.toISOString()]
  );
  return setServiceStatus(input.serviceId, 'active');
}

/**
 * Mid-cycle plan change. Swaps plan_id + rate_limit but leaves the
 * existing expiry_date intact — customers keep the days they paid for
 * when they upgrade/downgrade. Use renewService() if you want to also
 * reset the billing window.
 */
export async function changePlan(input: {
  serviceId: string;
  planId: string;
}): Promise<Service> {
  const sr = await query<Service>(
    `SELECT ${SERVICE_COLS} FROM services WHERE id = $1`, [input.serviceId]
  );
  if (!sr.rows[0]) throw notFound('service');

  const pr = await query<{
    speed_down_kbps: number | null; speed_up_kbps: number | null;
  }>(
    `SELECT speed_down_kbps, speed_up_kbps FROM plans WHERE id = $1 AND active = TRUE`,
    [input.planId]
  );
  const plan = pr.rows[0];
  if (!plan) throw notFound('plan');

  const rateLimit = (plan.speed_down_kbps && plan.speed_up_kbps)
    ? `${plan.speed_up_kbps}k/${plan.speed_down_kbps}k`
    : sr.rows[0].rate_limit;

  await query(
    `UPDATE services SET plan_id = $2, rate_limit = $3, updated_at = now() WHERE id = $1`,
    [input.serviceId, input.planId, rateLimit]
  );
  // Re-sync RADIUS so Mikrotik-Rate-Limit picks up the new value on next auth.
  // The active session keeps its old rate until reconnect — CoA-Change for
  // live rate updates is a separate enhancement.
  const final = await query<Service>(
    `SELECT ${SERVICE_COLS} FROM services WHERE id = $1`, [input.serviceId]
  );
  await syncServiceToRadius(final.rows[0]);
  return final.rows[0];
}

export interface BulkRow {
  full_name: string;
  phone?: string;
  email?: string;
  address?: string;
  username?: string;     // optional override; auto-generated otherwise
  password?: string;     // optional override; auto-generated otherwise
}

export interface BulkResult {
  created: Array<{
    row_index: number;
    account_number: string;
    full_name: string;
    phone: string | null;
    username: string;
    password: string;
  }>;
  errors: Array<{ row_index: number; full_name: string; message: string }>;
}

/**
 * Batch-create N customers + PPPoE services on the same plan. Per-row
 * isolation: a single bad phone number or duplicate username doesn't
 * roll back the others. Returns the generated creds for every successful
 * row so the operator can paste them into a bulk SMS or print them.
 *
 * Username strategy: take the requested base (or derive from full_name as
 * `firstinitial + lastword`), then append a numeric suffix if it collides
 * with an existing row. Password is 10 chars from a confusion-free
 * alphabet (no 0/O/1/I/l).
 */
export async function bulkCreateCustomers(input: {
  rows: BulkRow[];
  plan_id: string;
  router_id?: string;
}): Promise<BulkResult> {
  if (!input.rows.length) return { created: [], errors: [] };

  // Validate plan ONCE up front — fail-fast if the operator picked a bad plan.
  const pr = await query<{ id: string; validity_days: number }>(
    `SELECT id, validity_days FROM plans WHERE id = $1 AND active = TRUE`,
    [input.plan_id]
  );
  if (!pr.rows[0]) throw notFound('plan');

  const result: BulkResult = { created: [], errors: [] };
  // Track usernames minted in this batch so two rows with the same derived
  // base get different suffixes.
  const mintedUsernames = new Set<string>();

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    try {
      if (!row.full_name?.trim()) throw badRequest('full_name required');

      const customer = await createCustomer({
        full_name: row.full_name.trim(),
        phone: row.phone || undefined,
        email: row.email || undefined,
        address: row.address || undefined,
      });

      const username = await uniqueUsername(row.username || deriveUsername(row.full_name), mintedUsernames);
      mintedUsernames.add(username);
      const password = row.password || generatePassword();

      await createService({
        customer_id: customer.id,
        service_type: 'pppoe',
        username,
        password,
        plan_id: input.plan_id,
        router_id: input.router_id,
      });

      result.created.push({
        row_index: i,
        account_number: customer.account_number,
        full_name: customer.full_name,
        phone: customer.phone,
        username,
        password,
      });
    } catch (err) {
      result.errors.push({
        row_index: i,
        full_name: row.full_name,
        message: (err as Error).message,
      });
    }
  }
  return result;
}

function deriveUsername(fullName: string): string {
  const parts = fullName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'customer';
  if (parts.length === 1) return parts[0].replace(/[^a-z0-9]/g, '');
  const first = parts[0][0];
  const last = parts[parts.length - 1].replace(/[^a-z0-9]/g, '');
  return (first + last) || 'customer';
}

async function uniqueUsername(base: string, batchTaken: Set<string>): Promise<string> {
  const cleanBase = base.toLowerCase().replace(/[^a-z0-9]/g, '') || 'customer';
  // Cap search at 100 — past that something is wrong, fall through to a random suffix.
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? cleanBase : `${cleanBase}${i + 1}`;
    if (batchTaken.has(candidate)) continue;
    const r = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM services WHERE username = $1) AS exists`,
      [candidate]
    );
    if (!r.rows[0].exists) return candidate;
  }
  // Pathological fallback: append 6 random hex chars.
  return cleanBase + Math.random().toString(16).slice(2, 8);
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Sweep services whose expiry_date is in the past and mark them expired.
 * Returns the rows that were transitioned so the caller (cron / admin)
 * can log them or trigger side-effects per service. Also fires a customer
 * SMS so they know to renew rather than discovering the captive themselves.
 */
export async function expireDueServices(): Promise<Service[]> {
  // Join customer phone in the same scan so we don't N+1 to send SMS later.
  const r = await query<Service & { customer_phone: string | null }>(
    `SELECT ${SERVICE_COLS.split(',').map((c) => 's.' + c.trim()).join(', ')},
            c.phone AS customer_phone
       FROM services s JOIN customers c ON c.id = s.customer_id
      WHERE s.status = 'active' AND s.expiry_date IS NOT NULL AND s.expiry_date < now()`
  );
  const expired: Service[] = [];
  for (const row of r.rows) {
    try {
      const updated = await setServiceStatus(row.id, 'expired');
      expired.push(updated);
      // Fire-and-forget SMS to the customer with a deep-link to /renew. PPPoE
      // only — hotspot customers see captive on next connect, no SMS needed.
      if (row.customer_phone && row.username && row.service_type === 'pppoe') {
        notify('sms', row.customer_phone, renewSmsBody(row.username, 'expired'))
          .catch((e) => console.error('[expire] sms failed:', (e as Error).message));
      }
    } catch (err) {
      console.error('[auto-expire] failed for', row.id, (err as Error).message);
    }
  }
  return expired;
}

/**
 * Proactive "your plan expires in N hours" warning. Fires for active PPPoE
 * services whose expiry is inside the warning window (default 24h) and
 * haven't been warned in this cycle. `expiry_warned_at` gates re-sends;
 * renewService() clears the flag so the next cycle warns again.
 */
export async function notifyExpiringSoon(windowHours = 24): Promise<{ warned: number }> {
  const r = await query<{
    id: string; username: string | null; customer_phone: string | null; expiry_date: string;
  }>(
    `SELECT s.id, s.username, s.expiry_date, c.phone AS customer_phone
       FROM services s JOIN customers c ON c.id = s.customer_id
      WHERE s.status = 'active'
        AND s.service_type = 'pppoe'
        AND s.expiry_warned_at IS NULL
        AND s.expiry_date IS NOT NULL
        AND s.expiry_date > now()
        AND s.expiry_date < now() + ($1 || ' hours')::interval`,
    [String(windowHours)]
  );
  let warned = 0;
  for (const row of r.rows) {
    // Mark before SMS to prevent re-send loops if SMS hangs.
    await query(`UPDATE services SET expiry_warned_at = now() WHERE id = $1`, [row.id]);
    if (row.customer_phone && row.username) {
      try {
        await notify('sms', row.customer_phone, renewSmsBody(row.username, 'soon'));
        warned++;
      } catch (e) {
        console.error('[warn] sms failed:', (e as Error).message);
      }
    }
  }
  return { warned };
}

function renewSmsBody(username: string, when: 'expired' | 'soon'): string {
  const link = `https://${config.portal.host}/renew?username=${encodeURIComponent(username)}`;
  if (when === 'expired') {
    return `${config.brandName}: your internet expired. Renew via M-Pesa: ${link}`;
  }
  return `${config.brandName}: your plan ends soon. Renew now to avoid interruption: ${link}`;
}

export async function setServiceStatus(
  id: string,
  status: Service['status']
): Promise<Service> {
  const r = await query<Service>(
    `UPDATE services SET status = $2, updated_at = now()
     WHERE id = $1 RETURNING ${SERVICE_COLS}`,
    [id, status]
  );
  if (!r.rows[0]) throw notFound('service');
  const svc = r.rows[0];
  await syncServiceToRadius(svc);

  // If suspending, kick any active sessions via CoA so the user is dropped
  // within seconds rather than waiting for re-auth on next session-timeout.
  // Also push the customer's framed IP into the MikroTik's jtm-expired
  // address-list so their HTTP gets captive-redirected to the renew page.
  // Hybrid path: NO kick on suspend/restore. Customer's PPP session stays
  // alive across status changes. Captive redirect toggles instantly via the
  // jtm-expired address-list (SSH push on suspend, SSH remove on restore).
  // The customer keeps their current rate-limit until a natural reconnect —
  // CoA-Change to update rate on the live session is a separate enhancement.
  if (svc.username && wgManager.isEnabled()) {
    if (status !== 'active' && svc.service_type === 'pppoe') {
      await pushExpired(svc.username);
    }
  }
  // If restoring, clear them from the expired list across every MikroTik so
  // their next dial gets a clean network with no captive redirect lingering.
  if (status === 'active' && svc.username && wgManager.isEnabled()) {
    await clearExpired(svc.username);
  }
  return svc;
}

async function pushExpired(username: string): Promise<void> {
  // Each open session has framedipaddress + nasipaddress. Push that IP into
  // jtm-expired on the matching router. Address-list entry auto-expires in 7d
  // (defense in depth — if the customer goes offline we'd lose track).
  const sessions = await query<{ framed_ip: string; nas_ip: string }>(
    `SELECT host(framedipaddress) AS framed_ip, host(nasipaddress) AS nas_ip
       FROM radacct
      WHERE username = $1 AND acctstoptime IS NULL AND framedipaddress IS NOT NULL`,
    [username]
  );
  for (const s of sessions.rows) {
    const cmd = `/ip firewall address-list add list=jtm-expired address=${s.framed_ip} timeout=7d comment="jtm-expired ${username}"`;
    try {
      await wgManager.execOnRouter(s.nas_ip, cmd);
    } catch (err) {
      console.error('[expired] push failed:', (err as Error).message);
    }
  }
}

async function clearExpired(username: string): Promise<void> {
  // We don't know which NAS the customer last hit, so iterate every router we
  // manage and remove any address-list entry that matches this username.
  const routersR = await query<{ wg_tunnel_ip: string }>(
    `SELECT wg_tunnel_ip FROM routers WHERE wg_tunnel_ip IS NOT NULL`
  );
  const cmd = `/ip firewall address-list remove [find list=jtm-expired comment~"jtm-expired ${username}"]`;
  for (const r of routersR.rows) {
    try {
      await wgManager.execOnRouter(r.wg_tunnel_ip, cmd);
    } catch {
      // best-effort; offline router will catch up via reconcile scheduler
    }
  }
}

async function kickActiveSessions(username: string): Promise<void> {
  // Use host() to strip the /32 that INET::text would produce — otherwise the
  // join against nas.nasname (plain text "10.66.0.25") never matches.
  const sessions = await query<{
    nas_ip: string; session_id: string; secret: string;
  }>(
    `SELECT host(a.nasipaddress) AS nas_ip,
            a.acctsessionid AS session_id,
            n.secret AS secret
       FROM radacct a
       LEFT JOIN nas n ON n.nasname = host(a.nasipaddress)
      WHERE a.username = $1 AND a.acctstoptime IS NULL`,
    [username]
  );
  for (const s of sessions.rows) {
    // CoA Disconnect via RADIUS — the standards-compliant way.
    if (s.secret) {
      try {
        await wgManager.coaDisconnect({
          nasIp: s.nas_ip, sessionId: s.session_id, secret: s.secret, username,
        });
      } catch (err) {
        console.error('[coa] disconnect failed:', (err as Error).message);
      }
    }
    // Belt-and-suspenders: SSH-force-remove the PPP session. RouterOS sometimes
    // leaves residual PPPoE state after CoA that prevents the customer's client
    // from re-establishing without a manual router reboot. Explicit /ppp active
    // remove clears it. Quiet on failure.
    try {
      await wgManager.execOnRouter(
        s.nas_ip,
        `:do { /ppp active remove [find name="${username}"] } on-error={}`
      );
    } catch (err) {
      console.error('[ssh-kick] failed:', (err as Error).message);
    }
  }
}

export async function deleteService(id: string): Promise<void> {
  const r = await query<Service>(
    `SELECT username FROM services WHERE id = $1`, [id]
  );
  const username = r.rows[0]?.username;
  await query(`DELETE FROM services WHERE id = $1`, [id]);
  if (username) {
    await query(`DELETE FROM radcheck WHERE username = $1`, [username]);
    await query(`DELETE FROM radreply WHERE username = $1`, [username]);
  }
}
