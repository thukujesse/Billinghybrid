'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

interface Summary { total_cents: number; currency: string; period: string }
interface Stats { invoiced_cents: number; collected_cents: number; outstanding_cents: number; open_invoices: number; currency: string }
interface Invoice {
  id: string; slug: string; tenant_name: string; period: string;
  fixed_active: number; fixed_charge_cents: number; hotspot_revenue_cents: number;
  hotspot_charge_cents: number; total_cents: number; status: string; issued_at: string; paid_at: string | null;
}
interface Collection {
  id: string; slug: string; tenant_name: string; period: string | null;
  amount_cents: number; status: string; mpesa_receipt: string | null; created_at: string;
}
interface Dunning {
  enabled: boolean; grace_days: number; max_attempts: number;
  to_collect: Array<{ slug: string; period: string; amount_cents: number; attempts: number }>;
  to_suspend: Array<{ slug: string; period: string; amount_cents: number }>;
}

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-KE', { day: '2-digit', month: 'short' }) : '—');
const th: React.CSSProperties = { padding: '9px 12px', fontWeight: 600, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '9px 12px' };

function Badge({ status }: { status: string }) {
  const c = status === 'paid' || status === 'success' ? '#16a34a'
    : status === 'failed' || status === 'void' ? '#dc2626'
    : status === 'pending' ? '#d97706' : '#64748b';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: c }} />{status}</span>;
}

export default function PlatformBilling() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [dunning, setDunning] = useState<Dunning | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const [s, st, inv, col, dun] = await Promise.all([
        api<Summary>('/platform/summary'),
        api<Stats>('/platform/billing-stats'),
        api<Invoice[]>('/platform/invoices?limit=100'),
        api<Collection[]>('/platform/collections?limit=100'),
        api<Dunning>('/platform/dunning/preview'),
      ]);
      setSummary(s); setStats(st); setInvoices(inv); setCollections(col); setDunning(dun); setForbidden(false);
    } catch (e: any) {
      if (/forbidden|restricted/i.test(e.message)) setForbidden(true);
      else setToast({ ok: false, msg: e.message });
    }
  };
  useEffect(() => { load(); }, []);

  const setStatus = async (id: string, status: string) => {
    setBusy(id);
    try {
      await api(`/platform/invoices/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      setToast({ ok: true, msg: `Invoice marked ${status}` });
      await load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setBusy(null); }
  };

  if (forbidden) return <div className="container"><h1>Billing</h1><div className="card"><p>Restricted to the platform operator.</p></div></div>;

  return (
    <div className="container">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <h1 style={{ margin: 0 }}>Billing &amp; Collections</h1>
        <a href="/platform" style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 13 }}>← Tenants</a>
      </div>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>{toast.msg}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '16px 0' }}>
        <Card label={`Accrued (${summary?.period ?? 'this month'})`} value={money(summary?.total_cents ?? 0)} accent />
        <Card label="Invoiced (all time)" value={money(stats?.invoiced_cents ?? 0)} />
        <Card label="Collected" value={money(stats?.collected_cents ?? 0)} good />
        <Card label="Outstanding" value={money(stats?.outstanding_cents ?? 0)} sub={`${stats?.open_invoices ?? 0} open`} warn />
      </div>

      {dunning && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>Dunning</strong>
            <span style={{ fontSize: 12, color: dunning.enabled ? '#16a34a' : 'var(--muted)' }}>
              {dunning.enabled ? '● auto-collecting' : '○ off (set PLATFORM_DUNNING=true to enable)'}
            </span>
            <span className="sub" style={{ fontSize: 12, marginLeft: 'auto' }}>grace {dunning.grace_days}d · {dunning.max_attempts} attempts</span>
          </div>
          <div style={{ display: 'flex', gap: 24, marginTop: 10, fontSize: 13, flexWrap: 'wrap' }}>
            <div><strong>{dunning.to_collect.length}</strong> overdue to collect{dunning.to_collect.length ? `: ${dunning.to_collect.map((d) => d.slug).join(', ')}` : ''}</div>
            <div style={{ color: dunning.to_suspend.length ? '#dc2626' : undefined }}><strong>{dunning.to_suspend.length}</strong> would suspend{dunning.to_suspend.length ? `: ${dunning.to_suspend.map((d) => d.slug).join(', ')}` : ''}</div>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 15 }}>Invoices</h3>
      <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: 22 }}>
        <table className="table-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
            <th style={th}>ISP</th><th style={th}>Period</th><th style={th}>Fixed subs</th><th style={th}>Hotspot</th>
            <th style={{ ...th, textAlign: 'right' }}>Total</th><th style={th}>Status</th><th style={th}>Issued</th><th style={th}>Actions</th>
          </tr></thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...td, fontWeight: 600 }}>{i.tenant_name || i.slug}</td>
                <td style={td}>{i.period}</td>
                <td style={td}>{i.fixed_active} ({money(i.fixed_charge_cents)})</td>
                <td style={td}>{money(i.hotspot_charge_cents)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(i.total_cents)}</td>
                <td style={td}><Badge status={i.status} /></td>
                <td style={td}>{fmtDate(i.issued_at)}</td>
                <td style={td}>
                  {i.status !== 'paid' && <button className="ghost sm" disabled={busy === i.id} onClick={() => setStatus(i.id, 'paid')}>Mark paid</button>}
                  {i.status !== 'void' && i.status !== 'paid' && <button className="danger sm" disabled={busy === i.id} onClick={() => setStatus(i.id, 'void')} style={{ marginLeft: 6 }}>Void</button>}
                </td>
              </tr>
            ))}
            {!invoices.length && <tr><td colSpan={8}><div className="empty-state"><span className="icon">🧾</span>No invoices yet — they’re generated monthly (or via Collect).</div></td></tr>}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 15 }}>Collection history</h3>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
            <th style={th}>ISP</th><th style={th}>Period</th><th style={{ ...th, textAlign: 'right' }}>Amount</th>
            <th style={th}>Status</th><th style={th}>M-Pesa receipt</th><th style={th}>When</th>
          </tr></thead>
          <tbody>
            {collections.map((c) => (
              <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...td, fontWeight: 600 }}>{c.tenant_name || c.slug}</td>
                <td style={td}>{c.period ?? '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{money(c.amount_cents)}</td>
                <td style={td}><Badge status={c.status} /></td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{c.mpesa_receipt ?? '—'}</td>
                <td style={td}>{fmtDate(c.created_at)}</td>
              </tr>
            ))}
            {!collections.length && <tr><td colSpan={6}><div className="empty-state"><span className="icon">💸</span>No collection attempts yet.</div></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ label, value, sub, accent, good, warn }: { label: string; value: string; sub?: string; accent?: boolean; good?: boolean; warn?: boolean }) {
  const color = accent ? '#2563eb' : good ? '#16a34a' : warn ? '#d97706' : 'var(--text)';
  return (
    <div className="card" style={{ borderColor: accent ? '#2563eb' : undefined }}>
      <div className="sub" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 800, color }}>{value}</div>
      {sub && <div className="sub" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}
