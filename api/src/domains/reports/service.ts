import { query } from '../../db/pool.js';

/** Dashboard / revenue analytics (the doc's NET-NEW Reports Service). */
export async function dashboard() {
  const [subs, revenue, invoices, vouchersStat, recentPayments] = await Promise.all([
    query(`SELECT status, COUNT(*)::int AS n FROM subscribers GROUP BY status`),
    query(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS total, COUNT(*)::int AS n
           FROM payments WHERE status = 'success'`),
    query(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_cents),0)::bigint AS amount
           FROM invoices GROUP BY status`),
    query(`SELECT status, COUNT(*)::int AS n FROM vouchers GROUP BY status`),
    query(`SELECT id, provider, amount_cents, status, created_at
           FROM payments ORDER BY created_at DESC LIMIT 10`),
  ]);

  const byStatus = (rows: any[]) =>
    Object.fromEntries(rows.map((r) => [r.status, r.n]));

  return {
    subscribers: byStatus(subs.rows),
    revenue: { total_cents: Number(revenue.rows[0].total), payments: revenue.rows[0].n },
    invoices: invoices.rows,
    vouchers: byStatus(vouchersStat.rows),
    recent_payments: recentPayments.rows,
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
