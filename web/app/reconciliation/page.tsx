'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Unmatched {
  id: string; source: string; trans_id: string; amount_kes: number;
  msisdn: string; reference: string; reason: string; status: string;
  resolved_by: string | null; resolved_at: string | null; created_at: string;
}
interface PlanLite { id: string; name: string; price_cents: number }

const REASON_LABEL: Record<string, string> = { no_match: 'No match', underpaid: 'Underpaid' };

export default function Reconciliation() {
  const [rows, setRows] = useState<Unmatched[]>([]);
  const [plans, setPlans] = useState<PlanLite[]>([]);
  const [stats, setStats] = useState<{ open: number; openAmountKes: number } | null>(null);
  const [filter, setFilter] = useState<'unmatched' | 'claimed' | 'ignored' | 'all'>('unmatched');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [claimForm, setClaimForm] = useState<{ plan_id: string; phone: string; mac: string }>({ plan_id: '', phone: '', mac: '' });

  const load = async () => {
    setLoading(true);
    try {
      const [list, st] = await Promise.all([
        api<Unmatched[]>(`/payments/unmatched?status=${filter}`),
        api<{ open: number; openAmountKes: number }>('/payments/unmatched/stats'),
      ]);
      setRows(list); setStats(st);
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);
  useEffect(() => { api<PlanLite[]>('/hotspot/plans').then(setPlans).catch(() => {/* ignore */}); }, []);

  const startClaim = (u: Unmatched) => {
    setClaimId(u.id);
    setClaimForm({ plan_id: plans[0]?.id ?? '', phone: u.msisdn ?? '', mac: '' });
  };
  const submitClaim = async () => {
    if (!claimId) return;
    setBusy(claimId);
    try {
      await api(`/payments/unmatched/${claimId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ plan_id: claimForm.plan_id, phone: claimForm.phone || undefined, mac: claimForm.mac || undefined }),
      });
      setToast({ ok: true, msg: 'Payment claimed — customer granted access' });
      setClaimId(null);
      await load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setBusy(null); }
  };
  const ignore = async (u: Unmatched) => {
    if (!window.confirm(`Dismiss this ${u.amount_kes} KES payment from ${u.msisdn || 'unknown'}?`)) return;
    setBusy(u.id);
    try {
      await api(`/payments/unmatched/${u.id}/ignore`, { method: 'POST' });
      setToast({ ok: true, msg: 'Dismissed' });
      await load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setBusy(null); }
  };

  const when = (s: string) => { try { return new Date(s).toLocaleString(); } catch { return s; } };

  return (
    <div className="container">
      <h1 style={{ marginBottom: 2 }}>Reconciliation</h1>
      <p className="sub">Payments that arrived without matching a pending purchase — claim them to grant the customer access, or dismiss them.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      {stats && (
        <div style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
          <div className="card" style={{ flex: '0 0 auto', borderColor: stats.open ? '#dc2626' : undefined }}>
            <div className="sub" style={{ fontSize: 12 }}>Unclaimed</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: stats.open ? '#dc2626' : 'var(--text)' }}>{stats.open}</div>
            <div className="sub" style={{ fontSize: 12 }}>KES {stats.openAmountKes.toLocaleString()} outstanding</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, margin: '8px 0 14px' }}>
        {(['unmatched', 'claimed', 'ignored', 'all'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={filter === f ? '' : 'ghost'} style={{ textTransform: 'capitalize' }}>
            {f === 'unmatched' ? 'Open' : f}
          </button>
        ))}
      </div>

      {loading ? <p className="sub">Loading…</p> : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th style={th}>When</th><th style={th}>Source</th><th style={thR}>Amount</th>
                <th style={th}>Phone</th><th style={th}>Reference</th><th style={th}>Why</th>
                <th style={th}>Status</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{when(u.created_at)}</td>
                  <td style={td}><span style={{ textTransform: 'capitalize' }}>{u.source}</span></td>
                  <td style={{ ...tdR, fontWeight: 700 }}>KES {u.amount_kes}</td>
                  <td style={td}>{u.msisdn || '—'}</td>
                  <td style={td}><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{u.reference || '—'}</span></td>
                  <td style={td}>{REASON_LABEL[u.reason] ?? u.reason}</td>
                  <td style={td}>
                    {u.status === 'unmatched' ? <span style={{ color: '#d97706' }}>open</span>
                      : u.status === 'claimed' ? <span style={{ color: '#16a34a' }}>claimed{u.resolved_by ? ` · ${u.resolved_by}` : ''}</span>
                      : <span className="sub">ignored</span>}
                  </td>
                  <td style={td}>
                    {u.status === 'unmatched' && (
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="sm" disabled={busy === u.id} onClick={() => startClaim(u)}>Claim</button>
                        <button className="ghost sm" disabled={busy === u.id} onClick={() => ignore(u)}>Ignore</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={8}>
                  <div className="empty-state">
                    <span className="icon">{filter === 'unmatched' ? '✅' : '📭'}</span>
                    {filter === 'unmatched' ? 'No unmatched payments — everything reconciled.' : `No ${filter} payments.`}
                  </div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {claimId && (
        <div className="card" style={{ marginTop: 12, maxWidth: 560 }}>
          <h3 style={{ marginTop: 0, fontSize: 14 }}>Claim payment → grant access</h3>
          <p className="sub" style={{ marginTop: 0 }}>Creates a paid purchase for the chosen package and activates the customer (same as an auto-settled payment).</p>
          <label>Package</label>
          <select value={claimForm.plan_id} onChange={(e) => setClaimForm({ ...claimForm, plan_id: e.target.value })}>
            <option value="" disabled>Pick a package…</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — KES {Math.round(p.price_cents / 100)}</option>)}
          </select>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Phone</label>
              <input value={claimForm.phone} onChange={(e) => setClaimForm({ ...claimForm, phone: e.target.value })} placeholder="2547XXXXXXXX" />
            </div>
            <div style={{ flex: 1 }}>
              <label>MAC (optional)</label>
              <input value={claimForm.mac} onChange={(e) => setClaimForm({ ...claimForm, mac: e.target.value })} placeholder="AA:BB:CC:DD:EE:FF" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button onClick={submitClaim} disabled={!claimForm.plan_id || busy === claimId}>{busy === claimId ? 'Granting…' : 'Claim & grant'}</button>
            <button className="ghost" onClick={() => setClaimId(null)} disabled={busy === claimId}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'top' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right' };
