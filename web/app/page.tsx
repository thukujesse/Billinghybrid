import { api, money } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  let data: any = null;
  let error: string | null = null;
  try {
    data = await api('/dashboard');
  } catch (e: any) {
    error = e.message;
  }

  if (error) {
    return (
      <div className="container">
        <h1>Dashboard</h1>
        <div className="toast err">Could not reach the API: {error}. Is it running on :4000?</div>
      </div>
    );
  }

  const subs = data.subscribers ?? {};
  const totalSubs = Object.values(subs).reduce((a: number, b: any) => a + Number(b), 0);
  const pppoe = data.pppoe ?? { active: 0, expired: 0, suspended: 0, expiring_24h: 0 };

  return (
    <div className="container">
      <h1>Dashboard</h1>
      <p className="sub">Hybrid ISP billing — revenue, subscribers, invoices &amp; vouchers at a glance.</p>

      <div className="grid">
        <div className="card stat"><div className="label">Revenue (settled)</div><div className="value">{money(data.revenue.total_cents)}</div></div>
        <div className="card stat"><div className="label">Successful payments</div><div className="value">{data.revenue.payments}</div></div>
        <div className="card stat"><div className="label">Subscribers</div><div className="value">{totalSubs}</div></div>
        <div className="card stat"><div className="label">Active</div><div className="value" style={{ color: 'var(--green)' }}>{subs.active ?? 0}</div></div>
        <div className="card stat"><div className="label">Suspended</div><div className="value" style={{ color: 'var(--red)' }}>{subs.suspended ?? 0}</div></div>
      </div>

      <h2 style={{ marginTop: 28 }}>PPPoE</h2>
      <div className="grid">
        <div className="card stat">
          <div className="label">Active</div>
          <div className="value" style={{ color: 'var(--green)' }}>{pppoe.active}</div>
        </div>
        <div className="card stat">
          <div className="label">Expiring &lt; 24h</div>
          <div className="value" style={{ color: pppoe.expiring_24h > 0 ? '#d97706' : 'inherit' }}>
            {pppoe.expiring_24h}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Expired</div>
          <div className="value" style={{ color: pppoe.expired > 0 ? '#b91c1c' : 'inherit' }}>
            {pppoe.expired}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Suspended</div>
          <div className="value">{pppoe.suspended}</div>
        </div>
      </div>

      <h2>Invoices by status</h2>
      <table>
        <thead><tr><th>Status</th><th>Count</th><th>Amount</th></tr></thead>
        <tbody>
          {(data.invoices ?? []).map((r: any) => (
            <tr key={r.status}>
              <td><span className={`badge ${r.status}`}>{r.status}</span></td>
              <td>{r.n}</td>
              <td>{money(Number(r.amount))}</td>
            </tr>
          ))}
          {(!data.invoices || data.invoices.length === 0) && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>No invoices yet</td></tr>}
        </tbody>
      </table>

      <h2>Recent payments</h2>
      <table>
        <thead><tr><th>Provider</th><th>Amount</th><th>Status</th><th>When</th></tr></thead>
        <tbody>
          {(data.recent_payments ?? []).map((p: any) => (
            <tr key={p.id}>
              <td>{p.provider}</td>
              <td>{money(Number(p.amount_cents))}</td>
              <td><span className={`badge ${p.status}`}>{p.status}</span></td>
              <td style={{ color: 'var(--muted)' }}>{new Date(p.created_at).toLocaleString()}</td>
            </tr>
          ))}
          {(!data.recent_payments || data.recent_payments.length === 0) && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No payments yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
