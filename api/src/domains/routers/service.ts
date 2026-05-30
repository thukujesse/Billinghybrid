import { query } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';

export interface Router {
  id: string;
  name: string;
  host: string;
  api_port: number;
  type: 'mikrotik' | 'radius';
  site: string | null;
  status: 'online' | 'offline' | 'degraded';
  created_at: string;
}

export async function listRouters(): Promise<Router[]> {
  const r = await query<Router>('SELECT * FROM routers ORDER BY created_at DESC');
  return r.rows;
}

export async function getRouter(id: string): Promise<Router> {
  const r = await query<Router>('SELECT * FROM routers WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('router');
  return r.rows[0];
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

/** Assign a subscriber's service to a router. */
export async function assignSubscriber(subscriberId: string, routerId: string): Promise<void> {
  await getRouter(routerId);
  const r = await query('UPDATE subscribers SET router_id = $2 WHERE id = $1', [subscriberId, routerId]);
  if (r.rowCount === 0) throw notFound('subscriber');
}

/** The router a subscriber is homed on (or null). */
export async function routerForSubscriber(subscriberId: string): Promise<Router | null> {
  const r = await query<Router>(
    `SELECT rt.* FROM routers rt
     JOIN subscribers s ON s.router_id = rt.id
     WHERE s.id = $1`,
    [subscriberId]
  );
  return r.rows[0] ?? null;
}
