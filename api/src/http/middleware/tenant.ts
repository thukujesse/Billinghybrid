import type { Request, Response, NextFunction } from 'express';
import { runWithTenant, pool } from '../../db/pool.js';
import { resolveTenantByHost, poolForTenant } from '../../domains/tenants/service.js';

/**
 * Resolve the tenant for this request from its Host header and bind it for the
 * whole async chain so every downstream query() routes to the right database —
 * with NO call-site changes (AsyncLocalStorage carries the context).
 *
 * M2: look the hostname up in the control-DB tenant registry. An active tenant
 * binds its own billing pool; anything unknown, inactive, or unresolvable falls
 * back to the default pool so existing single-tenant traffic never breaks.
 */
export async function tenantMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  let ctx: { tenantId: string; pool: typeof pool; status?: string; uuid?: string } = { tenantId: 'default', pool };
  try {
    const t = await resolveTenantByHost(req.hostname);
    // A resolved tenant ALWAYS binds its own pool (active or suspended) so its
    // data can never leak onto the default tenant. Only unknown hosts, or
    // tenants still provisioning/failed, fall back to the default pool. The
    // status + uuid ride along for the suspension guard and cross-DB SMS billing.
    if (t && (t.status === 'active' || t.status === 'suspended')) {
      ctx = { tenantId: t.slug, pool: poolForTenant(t), status: t.status, uuid: t.id };
    }
  } catch {
    // Registry unreachable (e.g. control DB blip) — degrade to the default
    // tenant rather than 500 every request.
  }
  runWithTenant(ctx, () => next());
}
