import type pg from 'pg';
import { pool, poolForConnString, runWithTenant, currentTenantId } from '../../db/pool.js';
import { config } from '../../config.js';

/** Public API base URL for the CURRENT tenant — used when handing Safaricom /
 *  a provider a callback URL, so the confirmation routes back to THIS tenant's
 *  host (and DB). Isolated tenants get their subdomain; the default tenant (and
 *  no-context calls) keep the platform host. */
export function tenantApiBase(): string {
  const slug = currentTenantId();
  return slug && slug !== 'default'
    ? `https://${slug}.${config.control.baseDomain}`
    : config.publicApiUrl;
}

// ---------------------------------------------------------------------------
// Tenant registry (control plane). These rows live in the CONTROL DB (the
// default pool). Routing reads them BEFORE a tenant pool is bound, so EVERY
// function here talks to `pool` directly — never the ALS-routed query().
// ---------------------------------------------------------------------------

export type TenantStatus = 'pending' | 'provisioning' | 'active' | 'suspended' | 'failed';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  db_conn_string: string | null;
  status: TenantStatus;
  contact_phone?: string | null;
  contact_email?: string | null;
  created_at?: string;
}

// Host→tenant cache. The registry changes only on signup, so a short TTL keeps
// per-request routing off the DB without making new tenants wait long to go live.
const CACHE_TTL_MS = 60_000;
const hostCache = new Map<string, { t: Tenant | null; exp: number }>();

export function clearTenantCache(): void {
  hostCache.clear();
}

/** Lowercase, strip any :port, trim — the canonical form stored in tenant_domain.host. */
export function normalizeHost(raw: string): string {
  return (raw || '').toLowerCase().split(':')[0].trim();
}

/** Resolve the tenant that owns `host`, or null if no mapping exists. Cached. */
export async function resolveTenantByHost(rawHost: string): Promise<Tenant | null> {
  const host = normalizeHost(rawHost);
  const now = Date.now();
  const hit = hostCache.get(host);
  if (hit && hit.exp > now) return hit.t;

  const r = await pool.query<Tenant>(
    `SELECT t.id, t.slug, t.name, t.db_conn_string, t.status
       FROM tenant_domain d
       JOIN tenant t ON t.id = d.tenant_id
      WHERE d.host = $1`,
    [host]
  );
  const t = r.rows[0] ?? null;
  hostCache.set(host, { t, exp: now + CACHE_TTL_MS });
  return t;
}

/** The billing pool for a tenant — its own DB, or the control/default DB when
 *  db_conn_string is NULL (the original single-tenant install). */
export function poolForTenant(t: Tenant): pg.Pool {
  return t.db_conn_string ? poolForConnString(t.db_conn_string) : pool;
}

export async function listTenants(): Promise<Tenant[]> {
  const r = await pool.query<Tenant>(
    `SELECT id, slug, name, db_conn_string, status, contact_phone, contact_email, created_at
       FROM tenant ORDER BY created_at`
  );
  return r.rows;
}

/**
 * Run `fn` once per ACTIVE tenant, each inside that tenant's DB context, so a
 * background sweep covers every tenant's database — not just the default pool.
 * Per-tenant failures are isolated (logged, never abort the others). Falls back
 * to a single default-pool run when the registry is empty/unavailable (the
 * original single-tenant install). Returns the number of contexts run.
 *
 * This is the canonical fix for the "worker only touches the default tenant"
 * class of bug — use it for any periodic job that reads/writes tenant data.
 */
export async function eachTenant(fn: () => Promise<void>, label = 'worker'): Promise<number> {
  let tenants: Tenant[] = [];
  try { tenants = (await listTenants()).filter((t) => t.status === 'active'); }
  catch (e) { console.error(`[${label}] listTenants failed; default pool only:`, (e as Error).message); }
  if (tenants.length === 0) { await fn(); return 1; }
  for (const t of tenants) {
    try {
      await runWithTenant({ tenantId: t.slug, pool: poolForTenant(t), uuid: t.id, status: t.status }, fn);
    } catch (e) {
      console.error(`[${label}] tenant ${t.slug} failed:`, (e as Error).message);
    }
  }
  return tenants.length;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const r = await pool.query<Tenant>(
    `SELECT id, slug, name, db_conn_string, status, contact_phone, contact_email, created_at
       FROM tenant WHERE slug = $1`,
    [slug]
  );
  return r.rows[0] ?? null;
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const r = await pool.query<Tenant>(
    `SELECT id, slug, name, db_conn_string, status, contact_phone, contact_email, created_at
       FROM tenant WHERE id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

export async function slugTaken(slug: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM tenant WHERE slug = $1`, [slug]);
  return (r.rowCount ?? 0) > 0;
}

// --------------------------- registry mutations ---------------------------

export async function createTenantRow(input: {
  slug: string;
  name: string;
  db_conn_string: string | null;
  status?: TenantStatus;
  contact_phone?: string | null;
  contact_email?: string | null;
}): Promise<Tenant> {
  const r = await pool.query<Tenant>(
    `INSERT INTO tenant (slug, name, db_conn_string, status, contact_phone, contact_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, slug, name, db_conn_string, status, contact_phone, contact_email, created_at`,
    [input.slug, input.name, input.db_conn_string, input.status ?? 'provisioning',
     input.contact_phone ?? null, input.contact_email ?? null]
  );
  return r.rows[0];
}

export async function setTenantStatus(id: string, status: TenantStatus): Promise<void> {
  await pool.query(`UPDATE tenant SET status = $2 WHERE id = $1`, [id, status]);
  clearTenantCache();
}

/**
 * Change a tenant's subdomain: rename the slug and swap its auto
 * <slug>.<baseDomain> host mapping to the new one (other custom domains are
 * left intact). The tenant's database is NOT renamed — db_conn_string is opaque
 * routing state — only the public hostname changes. The new host becomes live +
 * TLS-served on first visit via on-demand TLS.
 */
export async function changeSubdomain(t: Tenant, newSlug: string, baseDomain: string): Promise<{ host: string }> {
  const oldHost = `${t.slug}.${baseDomain}`;
  const newHost = `${newSlug}.${baseDomain}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tenant SET slug = $1 WHERE id = $2`, [newSlug, t.id]);
    await client.query(`DELETE FROM tenant_domain WHERE host = $1 AND tenant_id = $2`, [oldHost, t.id]);
    await client.query(
      `INSERT INTO tenant_domain (host, tenant_id, is_primary) VALUES ($1, $2, true)
       ON CONFLICT (host) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, is_primary = true`,
      [newHost, t.id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  clearTenantCache();
  return { host: newHost };
}

export async function addDomain(host: string, tenantId: string, isPrimary = false): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_domain (host, tenant_id, is_primary)
     VALUES ($1, $2, $3)
     ON CONFLICT (host) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, is_primary = EXCLUDED.is_primary`,
    [normalizeHost(host), tenantId, isPrimary]
  );
  clearTenantCache();
}
