import { api, money } from '@/lib/api';

export const dynamic = 'force-dynamic';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

function RevenueChart({ data }: { data: { month: string; revenue_cents: number }[] }) {
  if (!data.length) return <p className="sub">No revenue yet.</p>;
  const w = 720, h = 220, pad = 30;
  const max = Math.max(...data.map((d) => d.revenue_cents), 1);
  const bw = (w - pad * 2) / data.length;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
      {data.map((d, i) => {
        const bh = ((h - pad * 2) * d.revenue_cents) / max;
        const x = pad + i * bw;
        const y = h - pad - bh;
        return (
          <g key={d.month}>
            <rect x={x + 4} y={y} width={bw - 8} height={bh} fill="#38bdf8" rx={3} />
            <text x={x + bw / 2} y={h - pad + 14} fontSize="9" fill="#64829e" textAnchor="middle">{d.month.slice(2)}</text>
          </g>
        );
      })}
      <text x={pad} y={16} fontSize="10" fill="#64829e">max {money(max)}</text>
    </svg>
  );
}

export default async function Reports() {
  let revenue: any[] = [], top: any[] = [], churn: any = null, error: string | null = null;
  try {
    [revenue, top, churn] = await Promise.all([
      api('/reports/revenue'),
      api('/reports/top-plans'),
      api('/reports/churn'),
    ]);
  } catch (e: any) { error = e.message; }

  if (error) return <div className="container"><h1>Reports</h1><div className="toast err">API error: {error}</div></div>;

  return (
    <div className="container">
      <h1>Revenue Analytics</h1>
      <p className="sub">Business intelligence — MRR, churn, revenue trend and plan popularity.</p>

      <div className="grid">
        <div className="card stat"><div className="label">MRR (monthly recurring)</div><div className="value">{money(churn.mrr_cents)}</div></div>
        <div className="card stat"><div className="label">Churn rate</div><div className="value" style={{ color: churn.churn_rate_pct > 10 ? 'var(--red)' : 'var(--green)' }}>{churn.churn_rate_pct}%</div></div>
        <div className="card stat"><div className="label">Active</div><div className="value" style={{ color: 'var(--green)' }}>{churn.active}</div></div>
        <div className="card stat"><div className="label">Suspended</div><div className="value" style={{ color: 'var(--red)' }}>{churn.suspended}</div></div>
      </div>

      <h2>Revenue (last 12 months)</h2>
      <RevenueChart data={revenue} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h2 style={{ margin: 0 }}>Top plans</h2>
        <a className="btn ghost" href={`${API}/api/reports/payments.csv`} style={{ textDecoration: 'none' }}>Export payments CSV</a>
      </div>
      <table>
        <thead><tr><th>Plan</th><th>Type</th><th>Price</th><th>Active subscribers</th></tr></thead>
        <tbody>
          {top.map((p: any) => (
            <tr key={p.name}><td>{p.name}</td><td>{p.type}</td><td>{money(p.price_cents)}</td><td>{p.active_subs}</td></tr>
          ))}
          {top.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No plans yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
