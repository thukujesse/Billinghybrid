import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';

// Postgres returns BIGINT (OID 20) as string by default to avoid precision
// loss. All our money columns fit safely in a JS number (< 2^53), so parse
// them to numbers for ergonomic arithmetic in the service layer.
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

// The default billing pool. In single-tenant mode it is the ONLY pool; the
// multitenant layer (M1) layers per-request routing on top WITHOUT changing the
// 100+ query() call sites — they resolve the current tenant's pool from ALS.
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// ---------------------------------------------------------------------------
// Multitenancy (M1: tenant context + single default tenant, zero behavior
// change). A middleware binds a TenantCtx for the request's async chain; query()
// reads it. Outside a request (workers, startup, migrations) there is no store,
// so getPool() falls back to the default pool — identical to before.
// ---------------------------------------------------------------------------
export interface TenantCtx {
  tenantId: string;
  pool: pg.Pool;
}
const tenantStore = new AsyncLocalStorage<TenantCtx>();

// Lazily-created, cached pools keyed by connection string — used by M2+ when a
// tenant routes to its own database. The default DSN always returns `pool`.
const poolCache = new Map<string, pg.Pool>();
export function poolForConnString(connectionString: string): pg.Pool {
  if (connectionString === config.databaseUrl) return pool;
  let p = poolCache.get(connectionString);
  if (!p) {
    p = new pg.Pool({ connectionString });
    poolCache.set(connectionString, p);
  }
  return p;
}

/** The pool for the current request's tenant, or the default pool outside a
 *  request (background workers, app startup, migrations). */
export function getPool(): pg.Pool {
  return tenantStore.getStore()?.pool ?? pool;
}

/** The current tenant id, or 'default' outside a request. */
export function currentTenantId(): string {
  return tenantStore.getStore()?.tenantId ?? 'default';
}

/** Bind a tenant context for the duration of `fn`'s async chain. */
export function runWithTenant<T>(ctx: TenantCtx, fn: () => T): T {
  return tenantStore.run(ctx, fn);
}

export type Queryable = Pick<pg.PoolClient, 'query'> | pg.Pool;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  client?: Queryable
): Promise<pg.QueryResult<T>> {
  // Explicit client (e.g. inside a transaction) wins; otherwise the current
  // tenant's pool.
  return (client ?? getPool()).query<T>(text, params as any[]);
}

/**
 * Run `fn` inside a single transaction on the CURRENT tenant's pool. Commits on
 * success, rolls back on any thrown error. Used wherever money moves.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
