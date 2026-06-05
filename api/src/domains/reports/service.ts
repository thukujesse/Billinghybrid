import { query } from '../../db/pool.js';

/**
 * Revenue source map. The system has two payment tables for historical
 * reasons:
 *   - `payments` (legacy) — wallet top-ups for the subscriber track
 *   - `hotspot_purchases` (modern) — M-Pesa STK for hotspot guests AND
 *     PPPoE renewals (the `service_id` column distinguishes them)
 *
 * The reports below treat both as one revenue stream so the operator
 * sees the actual total. Amount fields: payments.amount_cents (KES * 100),
 * hotspot_purchases.amount_kes (KES integer) — we normalise to cents.
 */
const REVENUE_UNION = `
  SELECT created_at, completed_at,
         (amount_kes * 100)::bigint AS amount_cents,
         CASE WHEN service_id IS NOT NULL THEN 'pppoe_renewal' ELSE 'hotspot_guest' END AS source,
         status, receipt AS reference
    FROM hotspot_purchases
  UNION ALL
  SELECT created_at, NULL AS completed_at, amount_cents,
         CASE WHEN provider = 'wallet' THEN 'wallet_topup' ELSE 'legacy_payment' END AS source,
         status, provider_ref AS reference
    FROM payments
`;

/** Dashboard / revenue analytics (the doc's NET-NEW Reports Service). */
export async function dashboard() {
  const [subs, revenue, invoices, vouchersStat, recentPayments, pppoe] = await Promise.all([
    query(`SELECT status, COUNT(*)::int AS n FROM subscribers GROUP BY status`),
    // Unified across both legacy payments AND hotspot_purchases — the home
    // tile previously showed only the legacy slice and looked wrong on
    // deployments where all M-Pesa flows through hotspot_purchases.
    query(`SELECT
             COALESCE(SUM(amount_cents) FILTER (WHERE status = 'success'), 0)::bigint AS total,
             COUNT(*) FILTER (WHERE status = 'success')::int AS n
           FROM (${REVENUE_UNION}) u`),
    query(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_cents),0)::bigint AS amount
           FROM invoices GROUP BY status`),
    query(`SELECT status, COUNT(*)::int AS n FROM vouchers GROUP BY status`),
    // Recent successful payments from BOTH sources, normalized.
    query(`SELECT created_at, source AS provider, amount_cents, status, reference AS provider_ref
             FROM (${REVENUE_UNION}) u
            WHERE status = 'success'
            ORDER BY created_at DESC LIMIT 10`),
    // PPPoE-specific tiles: status counts + an expiring-soon counter so the
    // operator sees retention risk at a glance. expiring_24h overlaps with
    // 'active' — they're still active until the sweep flips them.
    query(`SELECT
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
              COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
              COUNT(*) FILTER (
                WHERE status = 'active'
                  AND expiry_date IS NOT NULL
                  AND expiry_date > now()
                  AND expiry_date < now() + interval '24 hours'
              )::int AS expiring_24h
            FROM services WHERE service_type = 'pppoe'`),
  ]);

  const byStatus = (rows: any[]) =>
    Object.fromEntries(rows.map((r) => [r.status, r.n]));

  return {
    subscribers: byStatus(subs.rows),
    revenue: { total_cents: Number(revenue.rows[0].total), payments: revenue.rows[0].n },
    invoices: invoices.rows,
    vouchers: byStatus(vouchersStat.rows),
    recent_payments: recentPayments.rows,
    pppoe: pppoe.rows[0] ?? { active: 0, expired: 0, suspended: 0, expiring_24h: 0 },
  };
}

/** Monthly revenue series for charts. */
export async function revenueByMonth(months = 12) {
  const r = await query(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
            COALESCE(SUM(amount_cents),0)::bigint AS revenue_cents
     FROM payments
     WHERE status = 'success' AND created_at > now() - ($1 || ' months')::interval
     GROUP BY 1 ORDER BY 1`,
    [months]
  );
  return r.rows.map((row) => ({ month: row.month, revenue_cents: Number(row.revenue_cents) }));
}

/** Most popular plans by active subscriptions. */
export async function topPlans(limit = 10) {
  const r = await query(
    `SELECT p.name, p.type, p.price_cents,
            COUNT(s.id) FILTER (WHERE s.status = 'active')::int AS active_subs
     FROM plans p
     LEFT JOIN subscriptions s ON s.plan_id = p.id
     GROUP BY p.id
     ORDER BY active_subs DESC, p.price_cents DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows.map((row) => ({ ...row, price_cents: Number(row.price_cents) }));
}

/**
 * Churn snapshot + MRR. Churn rate here is suspended / (active + suspended);
 * MRR sums the price of active monthly (postpaid) subscriptions.
 */
export async function churnAndMrr() {
  const counts = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM subscribers GROUP BY status`
  );
  const by = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  const active = by.active ?? 0;
  const suspended = by.suspended ?? 0;
  const denom = active + suspended;
  const churnRate = denom ? Math.round((suspended / denom) * 10000) / 100 : 0;

  const mrr = await query<{ mrr: number }>(
    `SELECT COALESCE(SUM(p.price_cents),0)::bigint AS mrr
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.status = 'active' AND p.billing_cycle = 'monthly'`
  );
  return {
    active,
    suspended,
    inactive: by.inactive ?? 0,
    pending: by.pending ?? 0,
    churn_rate_pct: churnRate,
    mrr_cents: Number(mrr.rows[0].mrr),
  };
}

/** Successful payments as CSV (for finance exports). */
export async function paymentsCsv(): Promise<string> {
  const r = await query(
    `SELECT created_at, provider, amount_cents, currency, status, provider_ref
     FROM payments ORDER BY created_at DESC LIMIT 5000`
  );
  const header = 'created_at,provider,amount,currency,status,reference';
  const rows = r.rows.map((p) =>
    [p.created_at.toISOString?.() ?? p.created_at, p.provider, (Number(p.amount_cents) / 100).toFixed(2), p.currency, p.status, p.provider_ref ?? '']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );
  return [header, ...rows].join('\n');
}

// =====================================================================
// Unified revenue across both legacy payments and modern hotspot_purchases.
// Powers the rebuilt /reports page so the operator sees the actual total
// rather than just the legacy slice.
// =====================================================================

export interface RevenuePoint {
  month: string;            // YYYY-MM
  revenue_cents: number;
  hotspot_guest_cents: number;
  pppoe_renewal_cents: number;
  payment_count: number;
}

/** Monthly revenue series (successful payments only) — UNION of both sources. */
export async function revenueByMonthCombined(months = 12): Promise<RevenuePoint[]> {
  const r = await query<{
    month: string;
    revenue_cents: string;
    hotspot_guest_cents: string;
    pppoe_renewal_cents: string;
    payment_count: number;
  }>(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
            COALESCE(SUM(amount_cents) FILTER (WHERE status = 'success'), 0)::text AS revenue_cents,
            COALESCE(SUM(amount_cents) FILTER (WHERE status = 'success' AND source = 'hotspot_guest'), 0)::text AS hotspot_guest_cents,
            COALESCE(SUM(amount_cents) FILTER (WHERE status = 'success' AND source = 'pppoe_renewal'), 0)::text AS pppoe_renewal_cents,
            COUNT(*) FILTER (WHERE status = 'success')::int AS payment_count
       FROM (${REVENUE_UNION}) u
      WHERE created_at > now() - ($1 || ' months')::interval
      GROUP BY 1 ORDER BY 1`,
    [months]
  );
  return r.rows.map((row) => ({
    month: row.month,
    revenue_cents: Number(row.revenue_cents) || 0,
    hotspot_guest_cents: Number(row.hotspot_guest_cents) || 0,
    pppoe_renewal_cents: Number(row.pppoe_renewal_cents) || 0,
    payment_count: row.payment_count,
  }));
}

export interface RevenueByPlanRow {
  plan_id: string | null;
  plan_name: string;
  revenue_cents: number;
  payment_count: number;
  service_type: string | null;
}

/** Revenue grouped by plan (hotspot_purchases only — has plan_id linkage).
 *  Window is last N days, defaulting to 30. Sorted by revenue descending. */
export async function revenueByPlan(days = 30): Promise<RevenueByPlanRow[]> {
  const r = await query<RevenueByPlanRow & { revenue_cents: string }>(
    `SELECT hp.plan_id,
            COALESCE(p.name, 'Unknown plan') AS plan_name,
            p.type AS service_type,
            COALESCE(SUM(hp.amount_kes * 100), 0)::text AS revenue_cents,
            COUNT(*)::int AS payment_count
       FROM hotspot_purchases hp
       LEFT JOIN plans p ON p.id = hp.plan_id
      WHERE hp.status = 'success'
        AND hp.created_at > now() - ($1 || ' days')::interval
      GROUP BY hp.plan_id, p.name, p.type
      ORDER BY SUM(hp.amount_kes) DESC NULLS LAST
      LIMIT 50`,
    [days]
  );
  return r.rows.map((row) => ({ ...row, revenue_cents: Number(row.revenue_cents) || 0 }));
}

export interface OutstandingRenewals {
  expiring_24h: { count: number; potential_cents: number };
  expiring_7d: { count: number; potential_cents: number };
  expired_grace_7d: { count: number; potential_cents: number };
}

/** Revenue at risk — active PPPoE services expiring soon, plus already-
 *  expired ones still within a 7-day grace window where renewal is likely. */
export async function outstandingRenewals(): Promise<OutstandingRenewals> {
  const r = await query<{
    bucket: string;
    n: number;
    potential_cents: string;
  }>(
    `WITH buckets AS (
      SELECT s.id, p.price_cents,
        CASE
          WHEN s.status = 'active' AND s.expiry_date > now()        AND s.expiry_date < now() + interval '24 hours' THEN 'expiring_24h'
          WHEN s.status = 'active' AND s.expiry_date > now() + interval '24 hours' AND s.expiry_date < now() + interval '7 days'  THEN 'expiring_7d'
          WHEN s.status = 'expired' AND s.expiry_date > now() - interval '7 days'  THEN 'expired_grace_7d'
        END AS bucket
       FROM services s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.service_type = 'pppoe' AND p.price_cents IS NOT NULL
    )
    SELECT bucket, COUNT(*)::int AS n, COALESCE(SUM(price_cents), 0)::text AS potential_cents
      FROM buckets WHERE bucket IS NOT NULL GROUP BY bucket`
  );
  const by = Object.fromEntries(r.rows.map((row) => [row.bucket, row]));
  const get = (k: string) => ({
    count: by[k]?.n ?? 0,
    potential_cents: Number(by[k]?.potential_cents) || 0,
  });
  return {
    expiring_24h: get('expiring_24h'),
    expiring_7d: get('expiring_7d'),
    expired_grace_7d: get('expired_grace_7d'),
  };
}

/** PPPoE MRR — sum of plan prices for active monthly-ish services.
 *  Anything with validity_days between 25 and 35 counts as monthly. */
export async function pppoeMrr(): Promise<{ active_count: number; mrr_cents: number }> {
  const r = await query<{ active_count: number; mrr_cents: string }>(
    `SELECT COUNT(*)::int AS active_count,
            COALESCE(SUM(p.price_cents), 0)::text AS mrr_cents
       FROM services s JOIN plans p ON p.id = s.plan_id
      WHERE s.service_type = 'pppoe' AND s.status = 'active'
        AND p.validity_days BETWEEN 25 AND 35`
  );
  return {
    active_count: r.rows[0]?.active_count ?? 0,
    mrr_cents: Number(r.rows[0]?.mrr_cents) || 0,
  };
}

// ----------------- CSV exporters -----------------
// Operator-friendly UTF-8 CSV. Plain string assembly is fine at the volumes
// a small ISP sees (thousands of rows); switch to streaming when it stops
// fitting in memory.

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export async function customersCsv(): Promise<string> {
  const r = await query(
    `SELECT c.account_number, c.full_name, c.phone, c.email, c.address, c.status,
            c.created_at, c.notes,
            COUNT(s.id) FILTER (WHERE s.status = 'active') AS active_services,
            COUNT(s.id) FILTER (WHERE s.status = 'expired') AS expired_services,
            MIN(s.expiry_date) AS earliest_expiry
       FROM customers c
       LEFT JOIN services s ON s.customer_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 50000`
  );
  const header = csvRow([
    'account_number', 'full_name', 'phone', 'email', 'address', 'status',
    'created_at', 'active_services', 'expired_services', 'earliest_expiry', 'notes',
  ]);
  const rows = r.rows.map((c) => csvRow([
    c.account_number, c.full_name, c.phone, c.email, c.address, c.status,
    c.created_at, c.active_services, c.expired_services, c.earliest_expiry, c.notes,
  ]));
  return [header, ...rows].join('\n');
}

export async function hotspotPurchasesCsv(): Promise<string> {
  const r = await query(
    `SELECT hp.created_at, hp.completed_at, hp.checkout_request_id,
            hp.phone, hp.mac_address, hp.amount_kes, hp.status,
            hp.receipt, hp.failure_reason,
            CASE WHEN hp.service_id IS NOT NULL THEN 'pppoe_renewal' ELSE 'hotspot_guest' END AS source,
            p.name AS plan_name, s.username AS service_username, c.account_number
       FROM hotspot_purchases hp
       LEFT JOIN plans p ON p.id = hp.plan_id
       LEFT JOIN services s ON s.id = hp.service_id
       LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY hp.created_at DESC
      LIMIT 50000`
  );
  const header = csvRow([
    'created_at', 'completed_at', 'checkout_request_id', 'phone', 'mac_address',
    'amount_kes', 'status', 'receipt', 'failure_reason', 'source',
    'plan_name', 'service_username', 'account_number',
  ]);
  const rows = r.rows.map((p) => csvRow([
    p.created_at, p.completed_at, p.checkout_request_id, p.phone, p.mac_address,
    p.amount_kes, p.status, p.receipt, p.failure_reason, p.source,
    p.plan_name, p.service_username, p.account_number,
  ]));
  return [header, ...rows].join('\n');
}
