import type { Request, Response, NextFunction } from 'express';
import { runWithTenant, pool } from '../../db/pool.js';

/**
 * Resolve the tenant for this request and bind it for the whole async chain so
 * every downstream query() routes to the right database — with NO call-site
 * changes (AsyncLocalStorage carries the context).
 *
 * M1: single hard-coded "default" tenant → the default pool. Zero behavior
 * change; this exists to de-risk the query() routing before real tenants land.
 * M2+ will read req.hostname, look it up in the control-DB tenant registry, and
 * bind that tenant's own billing pool here.
 */
export function tenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // const host = req.hostname;  // M2: slug = first label of *.hubnetwifi.co.ke
  const ctx = { tenantId: 'default', pool };
  runWithTenant(ctx, () => next());
}
