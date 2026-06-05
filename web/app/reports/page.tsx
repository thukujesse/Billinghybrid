import { api, money } from '@/lib/api';

export const dynamic = 'force-dynamic';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface RevenuePoint {
  month: string;
  revenue_cents: number;
  hotspot_guest_cents: number;
  pppoe_renewal_cents: number;
  payment_count: number;
}
interface PlanRow {
  plan_id: string | null; plan_name: string;
  revenue_cents: number; payment_count: number;
  service_type: string | null;
}
interface Outstanding {
  expiring_24h: { count: number; potential_cents: number };
  expiring_7d:  { count: number; potential_cents: number };
  expired_grace_7d: { count: number; potential_cents: number };
}
interface PppoeMrr { active_count: number; mrr_cents: number; }

function StackedRevenueChart({ data }: { data: RevenuePoint[] }) {
  if (!data.length) {
    return <p className="sub">No revenue yet. Once M-Pesa payments start landing they'll show here.</p>;
  }
  const w = 820, h = 240, pad = 38;
  const max = Math.max(...data.map((d) => d.revenue_cents), 1);
  const bw = (w - pad * 2) / data.length;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
      {/* y-axis max */}
      <text x={pad} y={16} fontSize="10" fill="#64829e">max {money(max)}</text>
      {/* legend */}
      <g transform={`translate(${w - 200}, 6)`}>
        <rect x={0}  y={2} width={10} height={10} fill="#38bdf8" />
        <text x={14} y={11} fontSize="10" fill="#64829e">Hotspot guest</text>
        <rect x={100} y={2} width={10} height={10} fill="#22c55e" />
        <text x={114} y={11} fontSize="10" fill="#64829e">PPPoE renewal</text>
      </g>
      {data.map((d, i) => {
        const totalH = ((h - pad * 2) * d.revenue_cents) / max;
        const guestH = ((h - pad * 2) * d.hotspot_guest_cents) / max;
        const pppoeH = ((h - pad * 2) * d.pppoe_renewal_cents) / max;
        const x = pad + i * bw;
        const yBase = h - pad;
        return (
          <g key={d.month}>
            {/* PPPoE on top so the chart reads "growing" as PPPoE grows. */}
            <rect x={x + 4} y={yBase - guestH} width={bw - 8} height={guestH} fill="#38bdf8" rx={2} />
            <rect x={x + 4} y={yBase - guestH - pppoeH} width={bw - 8} height={pppoeH} fill="#22c55e" rx={2} />
            <text x={x + bw / 2} y={h - pad + 14} fontSize="9" fill="#64829e" textAnchor="middle">{d.month.slice(2)}</text>
            {d.revenue_cents > 0 && (
              <text x={x + bw / 2} y={yBase - totalH - 4} fontSize="9" fill="#0f172a" textAnchor="middle">
                {money(d.revenue_cents).replace('KES ', '')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default async function Reports() {
  let revenue: RevenuePoint[] = [];
  let byPlan: PlanRow[] = [];
  let outstanding: Outstanding | null = null;
  let mrr: PppoeMrr | null = null;
  let churn: any = null;
  let error: string | null = null;
  try {
    [revenue, byPlan, outstanding, mrr, churn] = await Promise.all([
      api<RevenuePoint[]>('/reports/revenue-combined?months=12'),
      api<PlanRow[]>('/reports/revenue-by-plan?days=30'),
      api<Outstanding>('/reports/outstanding-renewals'),
      api<PppoeMrr>('/reports/pppoe-mrr'),
      api('/reports/churn'),
    ]);
  } catch (e: any) {
    error = e.message;
  }

  if (error) {
    return (
      <div className="container">
        <h1>Reports</h1>
        <div className="toast err">API error: {error}</div>
      </div>
    );
  }

  const total12mo = revenue.reduce((a, b) => a + b.revenue_cents, 0);
  const hotspotShare = revenue.reduce((a, b) => a + b.hotspot_guest_cents, 0);
  const pppoeShare = revenue.reduce((a, b) => a + b.pppoe_renewal_cents, 0);
  const pppoeSharePct = total12mo > 0 ? Math.round((pppoeShare / total12mo) * 100) : 0;
  const outstandingTotal =
    (outstanding?.expiring_24h.potential_cents ?? 0) +
    (outstanding?.expiring_7d.potential_cents ?? 0) +
    (outstanding?.expired_grace_7d.potential_cents ?? 0);

  return (
    <div className="container">
      <h1>Revenue Analytics</h1>
      <p className="sub">
        Unified across M-Pesa hotspot purchases and PPPoE renewals. PPPoE MRR is the recurring
        monthly figure (active services on 25-35 day plans); 12-month total is everything settled.
      </p>

      <div className="grid">
        <div className="card stat">
          <div className="label">PPPoE MRR</div>
          <div className="value">{money(mrr?.mrr_cents ?? 0)}</div>
          <div className="sub" style={{ margin: 0 }}>{mrr?.active_count ?? 0} active monthly</div>
        </div>
        <div className="card stat">
          <div className="label">Revenue (12 mo)</div>
          <div className="value">{money(total12mo)}</div>
          <div className="sub" style={{ margin: 0 }}>{pppoeSharePct}% from PPPoE</div>
        </div>
        <div className="card stat">
          <div className="label">Renewals at risk (7d)</div>
          <div className="value" style={{ color: outstandingTotal > 0 ? '#d97706' : 'inherit' }}>
            {money(outstandingTotal)}
          </div>
          <div className="sub" style={{ margin: 0 }}>
            {(outstanding?.expiring_24h.count ?? 0) + (outstanding?.expiring_7d.count ?? 0)} expiring soon ·&nbsp;
            {outstanding?.expired_grace_7d.count ?? 0} just expired
          </div>
        </div>
        <div className="card stat">
          <div className="label">Churn (subscribers)</div>
          <div className="value" style={{ color: churn.churn_rate_pct > 10 ? 'var(--red)' : 'var(--green)' }}>
            {churn.churn_rate_pct}%
          </div>
          <div className="sub" style={{ margin: 0 }}>{churn.active} active · {churn.suspended} suspended</div>
        </div>
      </div>

      <h2 style={{ marginTop: 28 }}>Revenue by month</h2>
      <StackedRevenueChart data={revenue} />
      <p className="sub" style={{ marginTop: 6 }}>
        Hotspot:&nbsp;<strong>{money(hotspotShare)}</strong>&nbsp;·&nbsp;
        PPPoE renewals:&nbsp;<strong>{money(pppoeShare)}</strong>
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 32 }}>
        <h2 style={{ margin: 0 }}>Revenue by plan · last 30 days</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <a className="btn ghost" href={`${API}/api/reports/customers.csv`} style={{ textDecoration: 'none' }}>Export customers CSV</a>
          <a className="btn ghost" href={`${API}/api/reports/hotspot-purchases.csv`} style={{ textDecoration: 'none' }}>Export payments CSV</a>
        </div>
      </div>
      <table>
        <thead><tr><th>Plan</th><th>Type</th><th>Payments</th><th>Revenue (30d)</th></tr></thead>
        <tbody>
          {byPlan.map((p) => (
            <tr key={`${p.plan_id ?? 'none'}-${p.plan_name}`}>
              <td><strong>{p.plan_name}</strong></td>
              <td><span className="badge">{p.service_type ?? '—'}</span></td>
              <td>{p.payment_count}</td>
              <td><strong>{money(p.revenue_cents)}</strong></td>
            </tr>
          ))}
          {byPlan.length === 0 && (
            <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>
              No successful payments in the last 30 days.
            </td></tr>
          )}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>Renewals at risk</h2>
      <div className="grid">
        <div className="card stat">
          <div className="label">Expiring &lt; 24h</div>
          <div className="value" style={{ color: (outstanding?.expiring_24h.count ?? 0) > 0 ? '#d97706' : 'inherit' }}>
            {outstanding?.expiring_24h.count ?? 0}
          </div>
          <div className="sub" style={{ margin: 0 }}>{money(outstanding?.expiring_24h.potential_cents ?? 0)} at risk</div>
        </div>
        <div className="card stat">
          <div className="label">Expiring 1-7d</div>
          <div className="value">{outstanding?.expiring_7d.count ?? 0}</div>
          <div className="sub" style={{ margin: 0 }}>{money(outstanding?.expiring_7d.potential_cents ?? 0)}</div>
        </div>
        <div className="card stat">
          <div className="label">Expired &lt; 7d (grace)</div>
          <div className="value" style={{ color: (outstanding?.expired_grace_7d.count ?? 0) > 0 ? 'var(--red, #b91c1c)' : 'inherit' }}>
            {outstanding?.expired_grace_7d.count ?? 0}
          </div>
          <div className="sub" style={{ margin: 0 }}>{money(outstanding?.expired_grace_7d.potential_cents ?? 0)}</div>
        </div>
      </div>
      <p className="sub" style={{ marginTop: 8 }}>
        Customers in the &lt;24h and grace buckets get auto-SMS from the expire-worker.
        The 1-7d bucket is for proactive operator outreach.
      </p>
    </div>
  );
}
