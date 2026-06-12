import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { poolForTenant, type Tenant } from '../tenants/service.js';

// ---------------------------------------------------------------------------
// Platform billing: what HubNet charges each ISP tenant. Hybrid model —
//   fixed_charge   = active fixed-line subscribers (non-hotspot services) * KES 25
//   hotspot_charge = the tenant's hotspot revenue in the period * 3%
//
// Accruals are computed against EACH tenant's own database (poolForTenant);
// invoices are snapshotted into the CONTROL DB's tenant_invoice table.
// ---------------------------------------------------------------------------

export interface Accrual {
  fixed_active: number;
  fixed_per_sub_cents: number;
  fixed_charge_cents: number;
  hotspot_revenue_cents: number;
  hotspot_share_pct: number;
  hotspot_charge_cents: number;
  total_cents: number;
  currency: string;
  error?: boolean; // tenant DB unreachable / schema mismatch
}

const ZERO = (): Accrual => ({
  fixed_active: 0,
  fixed_per_sub_cents: config.control.billing.fixedPerSubCents,
  fixed_charge_cents: 0,
  hotspot_revenue_cents: 0,
  hotspot_share_pct: config.control.billing.hotspotSharePct,
  hotspot_charge_cents: 0,
  total_cents: 0,
  currency: config.control.billing.currency,
});

/**
 * Live charge for a tenant in a given month ('YYYY-MM', default current month).
 * Queries the tenant's billing DB directly. Degrades to zeros (error:true) if
 * the tenant DB is unreachable, so the operator console never hard-fails.
 */
export async function accrue(t: Tenant, period?: string): Promise<Accrual> {
  const { fixedPerSubCents, hotspotSharePct } = config.control.billing;
  const out = ZERO();
  // period filter: invoices are monthly. Default = current calendar month.
  const monthFilter = period
    ? `date_trunc('month', created_at) = to_date($1, 'YYYY-MM')`
    : `date_trunc('month', created_at) = date_trunc('month', now())`;
  const params = period ? [period] : [];

  try {
    const p = poolForTenant(t);
    // Active fixed-line subscribers = active services that aren't hotspot.
    const fixed = await p
      .query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM services
          WHERE status = 'active' AND service_type <> 'hotspot'`
      )
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => { out.error = true; return 0; });

    // Hotspot revenue in the period (hotspot_purchases.amount_kes is in KES).
    const hotspotRev = await p
      .query<{ c: string }>(
        `SELECT COALESCE(SUM(amount_kes) * 100, 0)::bigint::text AS c
           FROM hotspot_purchases
          WHERE status = 'success' AND ${monthFilter}`,
        params
      )
      .then((r) => Number(r.rows[0]?.c ?? 0))
      .catch(() => { out.error = true; return 0; });

    out.fixed_active = fixed;
    out.fixed_charge_cents = fixed * fixedPerSubCents;
    out.hotspot_revenue_cents = hotspotRev;
    out.hotspot_charge_cents = Math.round((hotspotRev * hotspotSharePct) / 100);
    out.total_cents = out.fixed_charge_cents + out.hotspot_charge_cents;
    return out;
  } catch {
    out.error = true;
    return out;
  }
}

/** Snapshot a tenant's charge for a period into the control DB (idempotent upsert). */
export async function generateInvoice(t: Tenant, period: string): Promise<void> {
  const a = await accrue(t, period);
  await pool.query(
    `INSERT INTO tenant_invoice
       (tenant_id, period, fixed_active, fixed_per_sub_cents, fixed_charge_cents,
        hotspot_revenue_cents, hotspot_share_pct, hotspot_charge_cents, total_cents, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, period) DO UPDATE SET
       fixed_active = EXCLUDED.fixed_active,
       fixed_per_sub_cents = EXCLUDED.fixed_per_sub_cents,
       fixed_charge_cents = EXCLUDED.fixed_charge_cents,
       hotspot_revenue_cents = EXCLUDED.hotspot_revenue_cents,
       hotspot_share_pct = EXCLUDED.hotspot_share_pct,
       hotspot_charge_cents = EXCLUDED.hotspot_charge_cents,
       total_cents = EXCLUDED.total_cents,
       issued_at = now()`,
    [t.id, period, a.fixed_active, a.fixed_per_sub_cents, a.fixed_charge_cents,
     a.hotspot_revenue_cents, a.hotspot_share_pct, a.hotspot_charge_cents, a.total_cents, a.currency]
  );
}

export interface Invoice {
  id: string; tenant_id: string; period: string;
  fixed_active: number; fixed_charge_cents: number;
  hotspot_revenue_cents: number; hotspot_charge_cents: number;
  total_cents: number; currency: string; status: string;
  issued_at: string; paid_at: string | null;
}

export async function hasInvoice(tenantId: string, period: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM tenant_invoice WHERE tenant_id = $1 AND period = $2`, [tenantId, period]);
  return (r.rowCount ?? 0) > 0;
}

export async function listInvoices(tenantId: string): Promise<Invoice[]> {
  const r = await pool.query<Invoice>(
    `SELECT id, tenant_id, period, fixed_active, fixed_charge_cents,
            hotspot_revenue_cents, hotspot_charge_cents, total_cents, currency,
            status, issued_at, paid_at
       FROM tenant_invoice WHERE tenant_id = $1 ORDER BY period DESC`,
    [tenantId]
  );
  return r.rows;
}

export async function setInvoiceStatus(id: string, status: 'issued' | 'paid' | 'void'): Promise<void> {
  await pool.query(
    `UPDATE tenant_invoice SET status = $2, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END WHERE id = $1`,
    [id, status]
  );
}
