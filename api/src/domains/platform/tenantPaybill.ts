import { pool, poolForConnString } from '../../db/pool.js';
import { conflict } from '../../lib/errors.js';
import type { Tenant } from '../tenants/service.js';

// ---------------------------------------------------------------------------
// Shared-callback routing: paybill/till -> tenant. Lives in the CONTROL DB so a
// single HubNet callback URL can resolve which tenant a C2B confirmation belongs
// to (by the receiving shortcode) and settle it in that tenant's database.
// ---------------------------------------------------------------------------

export type PaybillKind = 'paybill' | 'till' | 'bank';

/** Register (or re-affirm) a shortcode for a tenant. Rejects a number already
 *  owned by a DIFFERENT tenant so two ISPs can't claim the same paybill. */
export async function registerPaybill(shortcode: string, tenantId: string, kind: PaybillKind): Promise<void> {
  const code = (shortcode ?? '').trim();
  if (!code) return;
  const existing = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant_paybill WHERE shortcode = $1`, [code]
  );
  if (existing.rowCount && existing.rows[0].tenant_id !== tenantId) {
    throw conflict(`shortcode ${code} is already registered to another ISP`);
  }
  await pool.query(
    `INSERT INTO tenant_paybill (shortcode, tenant_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (shortcode) DO UPDATE SET kind = EXCLUDED.kind, updated_at = now()
       WHERE tenant_paybill.tenant_id = EXCLUDED.tenant_id`,
    [code, tenantId, kind]
  );
}

/** Remove a tenant's claim on a shortcode (e.g. when they switch it). */
export async function unregisterPaybill(shortcode: string, tenantId: string): Promise<void> {
  const code = (shortcode ?? '').trim();
  if (!code) return;
  await pool.query(`DELETE FROM tenant_paybill WHERE shortcode = $1 AND tenant_id = $2`, [code, tenantId]);
}

/** Resolve the tenant that owns `shortcode`, with its billing pool ready to bind. */
export async function resolvePaybill(shortcode: string): Promise<Tenant | null> {
  const code = (shortcode ?? '').trim();
  if (!code) return null;
  const r = await pool.query<Tenant>(
    `SELECT t.id, t.slug, t.name, t.db_conn_string, t.status
       FROM tenant_paybill p JOIN tenant t ON t.id = p.tenant_id
      WHERE p.shortcode = $1`,
    [code]
  );
  return r.rows[0] ?? null;
}

/** The billing pool for a resolved tenant (own DB, or control/default pool). */
export function poolForResolved(t: Tenant) {
  return t.db_conn_string ? poolForConnString(t.db_conn_string) : pool;
}
