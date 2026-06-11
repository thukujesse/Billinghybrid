/**
 * Network Digital Twin — Phase 1 read/write service.
 *
 * Stores the STRUCTURE of the network (sites, vendor-agnostic devices, links,
 * customer locations) and overlays LIVENESS at query time from radacct — so
 * the twin never duplicates session state and never sits in the auth path.
 * Vendor-agnostic: a device's `vendor` is pure data; nothing here branches on it.
 */
import { query } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { listLeadsForMap } from '../leads/service.js';

export type CustomerState = 'online' | 'offline' | 'suspended' | 'closed';

export interface TwinSite {
  id: string; name: string; type: string;
  latitude: number; longitude: number; address: string | null; notes: string | null;
}
export interface TwinDevice {
  id: string; name: string; device_role: string; device_kind: string;
  vendor: string | null; status: string;
  latitude: number; longitude: number;
  capacity: number | null; used_ports: number;
  parent_id: string | null; site_id: string | null;
}
export interface TwinCustomer {
  id: string; full_name: string; account_number: string; phone: string | null;
  latitude: number; longitude: number;
  state: CustomerState; online: boolean;
  service_count: number; service_type: string | null;
}
export interface TwinLink {
  id: string; kind: string; status: string;
  from_lat: number; from_lng: number; to_lat: number; to_lng: number;
  path_json: unknown;
}
export interface TwinLead {
  id: string; name: string; phone: string | null; stage: string;
  service_interest: string | null; latitude: number; longitude: number;
}
export interface TwinMap {
  sites: TwinSite[]; devices: TwinDevice[]; customers: TwinCustomer[]; links: TwinLink[]; leads: TwinLead[];
  counts: { sites: number; devices: number; customers: number; online: number; leads: number };
}

/** Everything geolocated, for the live map. Customers coloured by status +
 *  live RADIUS session (radacct open = online). */
export async function getMap(): Promise<TwinMap> {
  const sites = (await query<TwinSite>(
    `SELECT id, name, type, latitude, longitude, address, notes
       FROM sites WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
  )).rows;

  const devices = (await query<TwinDevice>(
    `SELECT id, name, device_role, device_kind, vendor, status,
            latitude, longitude, capacity, used_ports, parent_id, site_id
       FROM network_devices WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
  )).rows;

  const links = (await query<TwinLink>(
    `SELECT l.id, l.kind, l.status, l.path_json,
            df.latitude AS from_lat, df.longitude AS from_lng,
            dt.latitude AS to_lat,   dt.longitude AS to_lng
       FROM network_links l
       JOIN network_devices df ON df.id = l.from_id
       JOIN network_devices dt ON dt.id = l.to_id
      WHERE df.latitude IS NOT NULL AND dt.latitude IS NOT NULL`
  )).rows;

  // One row per located customer. online = any of their service usernames has
  // an OPEN radacct session (the join already filters acctstoptime IS NULL, so
  // a non-null radacctid means a live session).
  const rows = (await query<TwinCustomer & { customer_status: string }>(
    `SELECT c.id, c.full_name, c.account_number, c.phone,
            cl.latitude, cl.longitude,
            c.status AS customer_status,
            COALESCE(bool_or(ra.radacctid IS NOT NULL), false) AS online,
            COUNT(DISTINCT s.id)::int AS service_count,
            MIN(s.service_type) AS service_type
       FROM customer_locations cl
       JOIN customers c ON c.id = cl.customer_id
       LEFT JOIN services s ON s.customer_id = c.id
       LEFT JOIN radacct ra ON ra.username = s.username AND ra.acctstoptime IS NULL
      GROUP BY c.id, cl.latitude, cl.longitude, c.status`
  )).rows;

  const customers: TwinCustomer[] = rows.map((r) => {
    const state: CustomerState =
      r.customer_status === 'suspended' ? 'suspended' :
      r.customer_status === 'closed' ? 'closed' :
      r.online ? 'online' : 'offline';
    return {
      id: r.id, full_name: r.full_name, account_number: r.account_number, phone: r.phone,
      latitude: r.latitude, longitude: r.longitude,
      state, online: r.online, service_count: r.service_count, service_type: r.service_type,
    };
  });

  const leads = (await listLeadsForMap()) as TwinLead[];

  return {
    sites, devices, customers, links, leads,
    counts: {
      sites: sites.length,
      devices: devices.length,
      customers: customers.length,
      online: customers.filter((c) => c.online).length,
      leads: leads.length,
    },
  };
}

/** Customers not yet on the map — fed to the "place on map" panel. */
export async function listUnlocatedCustomers(limit = 200): Promise<Array<{
  id: string; full_name: string; account_number: string; phone: string | null;
}>> {
  return (await query(
    `SELECT id, full_name, account_number, phone
       FROM customers
      WHERE status <> 'closed'
        AND id NOT IN (SELECT customer_id FROM customer_locations)
      ORDER BY full_name
      LIMIT $1`,
    [limit]
  )).rows;
}

export async function createSite(input: {
  name: string; type?: string; latitude: number; longitude: number;
  address?: string; notes?: string;
}): Promise<TwinSite> {
  const r = await query<TwinSite>(
    `INSERT INTO sites (name, type, latitude, longitude, address, notes)
     VALUES ($1, COALESCE($2,'pop'), $3, $4, $5, $6)
     RETURNING id, name, type, latitude, longitude, address, notes`,
    [input.name, input.type ?? null, input.latitude, input.longitude, input.address ?? null, input.notes ?? null]
  );
  return r.rows[0];
}

export async function deleteSite(id: string): Promise<void> {
  await query(`DELETE FROM sites WHERE id = $1`, [id]);
}

export async function createDevice(input: {
  name: string; device_role?: string; device_kind: string;
  vendor?: string; transport?: string; mgmt_ip?: string;
  latitude: number; longitude: number;
  site_id?: string; parent_id?: string; capacity?: number;
}): Promise<TwinDevice> {
  const r = await query<TwinDevice>(
    `INSERT INTO network_devices
       (name, device_role, device_kind, vendor, transport, mgmt_ip,
        latitude, longitude, site_id, parent_id, capacity)
     VALUES ($1, COALESCE($2,'distribution'), $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, name, device_role, device_kind, vendor, status,
               latitude, longitude, capacity, used_ports, parent_id, site_id`,
    [input.name, input.device_role ?? null, input.device_kind, input.vendor ?? null,
     input.transport ?? null, input.mgmt_ip ?? null, input.latitude, input.longitude,
     input.site_id ?? null, input.parent_id ?? null, input.capacity ?? null]
  );
  return r.rows[0];
}

export async function deleteDevice(id: string): Promise<void> {
  await query(`DELETE FROM network_devices WHERE id = $1`, [id]);
}

/** Pin a customer onto the map (manual placement; install/survey later). */
export async function setCustomerLocation(customerId: string, input: {
  latitude: number; longitude: number; accuracy_m?: number; altitude_m?: number; source?: string;
}): Promise<void> {
  const c = await query(`SELECT 1 FROM customers WHERE id = $1`, [customerId]);
  if (!c.rowCount) throw badRequest('unknown customer');
  await query(
    `INSERT INTO customer_locations (customer_id, latitude, longitude, accuracy_m, altitude_m, source)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6,'manual'))
     ON CONFLICT (customer_id) DO UPDATE SET
       latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       accuracy_m = EXCLUDED.accuracy_m, altitude_m = EXCLUDED.altitude_m,
       source = EXCLUDED.source, updated_at = now()`,
    [customerId, input.latitude, input.longitude, input.accuracy_m ?? null, input.altitude_m ?? null, input.source ?? null]
  );
}

export async function removeCustomerLocation(customerId: string): Promise<void> {
  await query(`DELETE FROM customer_locations WHERE customer_id = $1`, [customerId]);
}
