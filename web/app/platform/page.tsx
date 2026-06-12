'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

interface Accrual {
  fixed_active: number; fixed_charge_cents: number;
  hotspot_revenue_cents: number; hotspot_charge_cents: number;
  total_cents: number; currency: string; error?: boolean;
}
interface TenantRow {
  id: string; slug: string; name: string; status: string;
  isolated: boolean; contact_phone: string | null; contact_email: string | null;
  created_at: string; accrual: Accrual;
}
interface Summary {
  tenants: number; active: number; suspended: number; period: string;
  fixed_active: number; fixed_charge_cents: number;
  hotspot_revenue_cents: number; hotspot_charge_cents: number; total_cents: number;
  currency: string; rates: { fixed_per_sub_cents: number; hotspot_share_pct: number };
}

const BASE = 'hubnetwifi.co.ke';

export default function Platform() {
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([
        api<Summary>('/platform/summary'),
        api<TenantRow[]>('/platform/tenants'),
      ]);
      setSummary(s); setRows(t); setForbidden(false);
    } catch (e: any) {
      if (/forbidden|restricted/i.test(e.message)) setForbidden(true);
      else setToast({ ok: false, msg: e.message });
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const act = async (id: string, path: string, label: string) => {
    setBusy(id);
    try {
      await api(`/platform/tenants/${id}/${path}`, { method: 'POST', body: '{}' });
      setToast({ ok: true, msg: label });
      await load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setBusy(null); }
  };

  if (forbidden) {
    return (
      <div className="container" style={{ maxWidth: 560 }}>
        <h1>Platform</h1>
        <div className="card"><p>This console is restricted to the platform operator (HubNet). Tenant admins manage their own ISP from their dashboard.</p></div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Platform · Tenants &amp; billing</h1>
      <p className="sub">Every ISP on the platform, with this month's accrued charge ({summary?.period}). Rates: KES {(summary?.rates.fixed_per_sub_cents ?? 0) / 100}/active fixed-line sub + {summary?.rates.hotspot_share_pct}% of hotspot revenue.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, margin: '14px 0' }}>
          <SummaryCard label="Tenants" value={`${summary.tenants}`} sub={`${summary.active} active · ${summary.suspended} suspended`} />
          <SummaryCard label="Fixed-line subs" value={`${summary.fixed_active}`} sub={`${money(summary.fixed_charge_cents)} this month`} />
          <SummaryCard label="Hotspot revenue" value={money(summary.hotspot_revenue_cents)} sub={`${money(summary.hotspot_charge_cents)} share`} />
          <SummaryCard label="Platform MRR (accrued)" value={money(summary.total_cents)} sub={`period ${summary.period}`} accent />
        </div>
      )}

      {loading ? <p className="sub">Loading…</p> : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th style={th}>ISP</th>
                <th style={th}>Status</th>
                <th style={th}>Fixed subs</th>
                <th style={th}>Hotspot rev</th>
                <th style={thR}>Charge (mo)</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{t.name}</div>
                    <a href={`https://${t.slug}.${BASE}`} target="_blank" rel="noreferrer" style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {t.slug}.{BASE} ↗
                    </a>
                    {t.accrual.error && <span style={{ color: 'var(--err,#dc2626)', fontSize: 11 }}> · stats unavailable</span>}
                  </td>
                  <td style={td}><StatusBadge status={t.status} /></td>
                  <td style={td}>{t.accrual.fixed_active} <span className="sub">({money(t.accrual.fixed_charge_cents)})</span></td>
                  <td style={td}>{money(t.accrual.hotspot_revenue_cents)} <span className="sub">({money(t.accrual.hotspot_charge_cents)})</span></td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{money(t.accrual.total_cents)}</td>
                  <td style={td}>
                    {t.slug === 'default' ? <span className="sub">—</span> : t.status === 'suspended' ? (
                      <button className="ghost" disabled={busy === t.id} onClick={() => act(t.id, 'resume', `${t.name} resumed`)}>Resume</button>
                    ) : (
                      <button className="ghost" disabled={busy === t.id} onClick={() => act(t.id, 'suspend', `${t.name} suspended`)}>Suspend</button>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td style={td} colSpan={6}><span className="sub">No tenants yet.</span></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'top' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right' };

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="card" style={{ borderColor: accent ? '#2563eb' : undefined }}>
      <div className="sub" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent ? '#2563eb' : 'var(--text)' }}>{value}</div>
      {sub && <div className="sub" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'active' ? '#16a34a' : status === 'suspended' ? '#dc2626'
    : status === 'provisioning' ? '#d97706' : 'var(--muted)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
      {status}
    </span>
  );
}
