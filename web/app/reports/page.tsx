import { money } from '@/lib/api';
import { serverApi } from '@/lib/serverApi';

export const dynamic = 'force-dynamic';

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
interface RouterRow {
  router_id: string | null; router_name: string; site: string | null;
  revenue_cents: number; payment_count: number;
}
interface AccountRow {
  collection_account_id: string | null; label: string;
  method: string | null; destination: string | null;
  revenue_cents: number; payment_count: number;
}
interface RouterOpt { id: string; name: string }

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, lifetime: 36500 };
const RANGE_LABEL: Record<string, string> = { '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', lifetime: 'all time' };
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

export default async function Reports({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const sp = (await searchParams) ?? {};
  const range = sp.range && RANGE_DAYS[sp.range] ? sp.range : 'lifetime';
  const venue = sp.venue || '';
  const days = RANGE_DAYS[range];
  const rangeLabel = RANGE_LABEL[range];
  const venueQ = venue ? `&router=${encodeURIComponent(venue)}` : '';

  let revenue: RevenuePoint[] = [];
  let byPlan: PlanRow[] = [];
  let byRouter: RouterRow[] = [];
  let byAccount: AccountRow[] = [];
  let routerOpts: RouterOpt[] = [];
  let outstanding: Outstanding | null = null;
  let mrr: PppoeMrr | null = null;
  let churn: any = null;
  let error: string | null = null;
  try {
    [revenue, byPlan, byRouter, byAccount, routerOpts, outstanding, mrr, churn] = await Promise.all([
      serverApi<RevenuePoint[]>('/reports/revenue-combined?months=12'),
      serverApi<PlanRow[]>(`/reports/revenue-by-plan?days=${days}${venueQ}`),
      serverApi<RouterRow[]>(`/reports/revenue-by-router?days=${days}`),
      serverApi<AccountRow[]>(`/reports/revenue-by-account?days=${days}${venueQ}`),
      serverApi<RouterOpt[]>('/routers'),
      serverApi<Outstanding>('/reports/outstanding-renewals'),
      serverApi<PppoeMrr>('/reports/pppoe-mrr'),
      serverApi('/reports/churn'),
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

      <form method="get" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', margin: '10px 0 2px' }}>
        <div>
          <label className="sub" style={{ display: 'block', fontSize: 12, marginBottom: 2 }}>Window</label>
          <select name="range" defaultValue={range}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="lifetime">Lifetime</option>
          </select>
        </div>
        <div>
          <label className="sub" style={{ display: 'block', fontSize: 12, marginBottom: 2 }}>Venue</label>
          <select name="venue" defaultValue={venue}>
            <option value="">All venues</option>
            {routerOpts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <button type="submit">Apply</button>
        <span className="sub" style={{ fontSize: 12, paddingBottom: 6 }}>The plan / account / venue tables below reflect this window{venue ? ' and venue' : ''}.</span>
      </form>

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
        <h2 style={{ margin: 0 }}>Revenue by plan · {rangeLabel}</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <a className="btn ghost" href="/api/reports/customers.csv" style={{ textDecoration: 'none' }}>Export customers CSV</a>
          <a className="btn ghost" href="/api/reports/hotspot-purchases.csv" style={{ textDecoration: 'none' }}>Export payments CSV</a>
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
              No successful payments in this window.
            </td></tr>
          )}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>Revenue by collection account · {rangeLabel}</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Which paybill / till / bank destination received the money. &ldquo;Direct / global&rdquo; covers
        STK / aggregator collection, the legacy single config, and any deleted account.
      </p>
      <table>
        <thead><tr><th>Account</th><th>Method</th><th>Destination</th><th>Payments</th><th>Revenue</th></tr></thead>
        <tbody>
          {byAccount.map((a) => (
            <tr key={a.collection_account_id ?? 'direct'}>
              <td>{a.collection_account_id
                ? <strong>{a.label}</strong>
                : <span style={{ color: 'var(--muted)' }}>{a.label}</span>}</td>
              <td>{a.method ? <span className="badge" style={{ textTransform: 'capitalize' }}>{a.method}</span> : '—'}</td>
              <td>{a.destination || '—'}</td>
              <td>{a.payment_count}</td>
              <td><strong>{money(a.revenue_cents)}</strong></td>
            </tr>
          ))}
          {byAccount.length === 0 && (
            <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No hotspot revenue in this window.</td></tr>
          )}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>Revenue by venue · {rangeLabel}</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Hotspot revenue attributed to the MikroTik the customer paid through (per-router collection).
        &ldquo;Unattributed&rdquo; covers purchases with no router context.
      </p>
      <table>
        <thead><tr><th>Router / venue</th><th>Site</th><th>Payments</th><th>Revenue (30d)</th></tr></thead>
        <tbody>
          {byRouter.map((r) => (
            <tr key={r.router_id ?? 'none'}>
              <td>{r.router_id
                ? <a href={`/routers/${r.router_id}`}><strong>{r.router_name}</strong></a>
                : <span style={{ color: 'var(--muted)' }}>{r.router_name}</span>}</td>
              <td>{r.site || '—'}</td>
              <td>{r.payment_count}</td>
              <td><strong>{money(r.revenue_cents)}</strong></td>
            </tr>
          ))}
          {byRouter.length === 0 && (
            <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>
              No hotspot revenue in this window.
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
