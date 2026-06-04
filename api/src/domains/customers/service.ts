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
