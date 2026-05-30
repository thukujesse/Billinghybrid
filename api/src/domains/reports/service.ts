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
