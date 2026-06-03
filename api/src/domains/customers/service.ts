import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import * as wgManager from '../../lib/wgManager.js';

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
  ip_address, mac_address, vlan_id, router_id, rate_limit, status,
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
      // PPPoE LIMP MODE: keep credentials so customer CAN authenticate, but
      // direct them to the EXPIRED pool (different /16 from active) via the
      // Framed-Pool reply attribute. Their framed IP comes from 10.8.0.0/16
      // automatically — no dynamic address-list needed. Firewall + DST-NAT
      // match on that subnet to redirect HTTP to the renew portal. When admin
      // Restores them, they get an IP from the active pool (10.7.0.0/16)
      // on next dial → no captive rules match → full speed.
      await client.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
        [svc.username, 'Cleartext-Password', ':=', svc.password]
      );
      await client.query(
        `INSERT INTO radreply (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
        [svc.username, 'Framed-Pool', '=', 'jtm-ppp-expired-pool']
      );
      await client.query(
        `INSERT INTO radreply (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
        [svc.username, 'Mikrotik-Rate-Limit', '=', '512k/512k']
      );
    } else {
      // Hotspot or other: hard-reject (hotspot has its own captive portal flow).
      await client.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
        [svc.username, 'Auth-Type', ':=', 'Reject']
      );
    }
  });
}

export interface CustomerWithServiceSummary extends Customer {
  services: Pick<Service, 'id' | 'service_type' | 'username' | 'rate_limit' | 'status'>[];
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
  }>(
    `SELECT id, customer_id, service_type, username, rate_limit, status
       FROM services WHERE customer_id = ANY($1::uuid[])
       ORDER BY created_at`,
    [ids]
  );
  const byCustomer = new Map<string, CustomerWithServiceSummary['services']>();
  for (const s of sr.rows) {
    if (!byCustomer.has(s.customer_id)) byCustomer.set(s.customer_id, []);
    byCustomer.get(s.customer_id)!.push({
      id: s.id, service_type: s.service_type, username: s.username,
      rate_limit: s.rate_limit, status: s.status,
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

  const r = await query<Service>(
    `INSERT INTO services
       (customer_id, service_type, username, password, ip_address, mac_address,
        vlan_id, router_id, rate_limit, expiry_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SERVICE_COLS}`,
    [input.customer_id, input.service_type, input.username ?? null,
     input.password ?? null, input.ip_address ?? null, input.mac_address ?? null,
     input.vlan_id ?? null, input.router_id ?? null, input.rate_limit ?? null,
     input.expiry_date ?? null]
  );
  const service = r.rows[0];
  await syncServiceToRadius(service);
  return service;
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
  // Kick active sessions on ANY status change. Without this, Restore leaves
  // the customer stuck on their previous PPP session with the OLD reply
  // attributes (e.g., still in expired pool with 512k cap) until something
  // else disconnects them. CoA Disconnect → re-auth → new attributes apply.
  if (svc.username && wgManager.isEnabled()) {
    await kickActiveSessions(svc.username);
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
