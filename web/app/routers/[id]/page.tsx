'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

type Tab = 'system' | 'users' | 'reports' | 'events' | 'payments' | 'backups' | 'diagnosis';
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'system', label: 'System Information', icon: '🖥' },
  { id: 'users', label: 'Internet Users', icon: '👥' },
  { id: 'reports', label: 'Reports', icon: '📊' },
  { id: 'events', label: 'Device Events', icon: '🔔' },
  { id: 'payments', label: 'Payments', icon: '💳' },
  { id: 'diagnosis', label: 'Diagnosis', icon: '🩺' },
  { id: 'backups', label: 'Backups', icon: '🗄' },
];

interface RouterLite { id: string; name: string; status: string; vpn_status: string; host: string; site: string | null; collection_account_id: string | null }
interface CollAccount { id: string; label: string; method: string; paybill: string; till: string; account_no: string; is_default: boolean }
interface SystemInfo {
  system: Record<string, any>;
  radius: Record<string, any>;
}
interface Sessions { online: any[]; recent: any[] }
interface PaymentsData {
  recent: any[];
  summary: { today_count: number; today_kes: number; month_count: number; month_kes: number; total_count: number; total_kes: number };
}
interface DiagResult { reachable: boolean; board: string; checks: Array<{ key: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string }> }

function bytes(n: number): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${u[i]}`;
}
function uptime(seconds: number): string {
  const s = Number(seconds) || 0;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m';
}
function when(x: string | null): string {
  if (!x) return '—';
  const d = new Date(x);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

const EVENT_STYLE: Record<string, [string, string]> = {
  online: ['rgba(22,163,74,0.12)', '#16a34a'],
  offline: ['rgba(220,38,38,0.10)', '#dc2626'],
  error: ['rgba(220,38,38,0.10)', '#dc2626'],
  created: ['rgba(37,99,235,0.10)', '#2563eb'],
  provisioned: ['rgba(37,99,235,0.10)', '#2563eb'],
  reprovisioned: ['rgba(37,99,235,0.10)', '#2563eb'],
  configured: ['rgba(232,89,12,0.12)', '#e8590c'],
  backup: ['rgba(120,120,120,0.14)', '#6b7280'],
};
const DIAG_ICON: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✗' };
const DIAG_COLOR: Record<string, string> = { ok: '#16a34a', warn: '#d97706', fail: '#dc2626' };

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <button
      className="ghost"
      style={{ fontSize: 12, padding: '3px 9px' }}
      onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); }}
    >{done ? '✓ Copied' : '⧉ Copy'}</button>
  );
}

function Field({ label, value, secret }: { label: string; value: any; secret?: boolean }) {
  const [show, setShow] = useState(false);
  const v = value == null || value === '' ? '—' : String(value);
  const display = secret && !show ? '•'.repeat(Math.min(10, v.length)) : v;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 14, fontFamily: secret ? 'monospace' : undefined }}>{display}</strong>
        {secret && v !== '—' && (
          <button className="nav-icon-btn" style={{ fontSize: 13 }} onClick={() => setShow((s) => !s)} title={show ? 'Hide' : 'Reveal'}>{show ? '🙈' : '👁'}</button>
        )}
        {v !== '—' && <Copy value={v} />}
      </span>
    </div>
  );
}

export default function RouterDetail() {
  const params = useParams();
  const id = String(params?.id ?? '');
  const [tab, setTab] = useState<Tab>('system');
  const [router, setRouter] = useState<RouterLite | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [users, setUsers] = useState<Sessions | null>(null);
  const [metrics, setMetrics] = useState<any[] | null>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const [payments, setPayments] = useState<PaymentsData | null>(null);
  const [backups, setBackups] = useState<any[] | null>(null);
  const [diag, setDiag] = useState<DiagResult | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [collAccts, setCollAccts] = useState<CollAccount[]>([]);
  const [savingColl, setSavingColl] = useState(false);

  useEffect(() => { if (id) api<RouterLite>(`/routers/${id}`).then(setRouter).catch((e) => setErr(e.message)); }, [id]);
  useEffect(() => { api<CollAccount[]>('/settings/collection-accounts').then(setCollAccts).catch(() => {/* ignore */}); }, []);

  const assignCollAcct = async (accountId: string | null) => {
    if (!router) return;
    setSavingColl(true);
    try {
      await api(`/routers/${id}/collection-account`, { method: 'PUT', body: JSON.stringify({ collection_account_id: accountId }) });
      setRouter({ ...router, collection_account_id: accountId });
    } catch (e: any) { setErr(e.message); }
    finally { setSavingColl(false); }
  };
  const collDest = (a: CollAccount) =>
    a.method === 'bank' ? `Bank ${a.paybill}/${a.account_no}` : a.method === 'till' ? `Till ${a.till}` : `Paybill ${a.paybill}`;
  const defaultColl = collAccts.find((a) => a.is_default);
  useEffect(() => {
    if (!id) return;
    if (tab === 'system' && !sys) api<SystemInfo>(`/routers/${id}/system`).then(setSys).catch((e) => setErr(e.message));
    if (tab === 'users' && !users) api<Sessions>(`/routers/${id}/users`).then(setUsers).catch((e) => setErr(e.message));
    if (tab === 'reports' && !metrics) api<any[]>(`/routers/${id}/metrics?hours=24`).then(setMetrics).catch((e) => setErr(e.message));
    if (tab === 'events' && !events) api<any[]>(`/routers/${id}/events`).then(setEvents).catch((e) => setErr(e.message));
    if (tab === 'payments' && !payments) api<PaymentsData>(`/routers/${id}/payments`).then(setPayments).catch((e) => setErr(e.message));
    if (tab === 'backups' && !backups) api<any[]>(`/routers/${id}/backups`).then(setBackups).catch((e) => setErr(e.message));
  }, [id, tab, sys, users, metrics, events, payments, backups]);

  const runDiag = async () => {
    setDiagRunning(true); setErr(null);
    try { setDiag(await api<DiagResult>(`/routers/${id}/diagnose`)); }
    catch (e: any) { setErr(e.message); }
    finally { setDiagRunning(false); }
  };
  const createBackup = async () => {
    setBackupBusy(true); setErr(null);
    try {
      await api(`/routers/${id}/backups`, { method: 'POST', body: JSON.stringify({}) });
      setBackups(await api<any[]>(`/routers/${id}/backups`));
    } catch (e: any) { setErr(e.message); }
    finally { setBackupBusy(false); }
  };
  const downloadBackup = async (b: any) => {
    setErr(null);
    try {
      const full = await api<any>(`/routers/${id}/backups/${b.id}`);
      const blob = new Blob([full.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date(b.created_at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(router?.name || 'router').replace(/\s+/g, '-')}-${stamp}.rsc`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) { setErr(e.message); }
  };
  const deleteBackup = async (b: any) => {
    if (!window.confirm('Delete this backup?')) return;
    setErr(null);
    try {
      await api(`/routers/${id}/backups/${b.id}`, { method: 'DELETE' });
      setBackups((bs) => (bs || []).filter((x) => x.id !== b.id));
    } catch (e: any) { setErr(e.message); }
  };

  const online = router?.vpn_status === 'connected' || router?.status === 'online';

  return (
    <div className="container">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{router?.name ?? 'Router'}</h1>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '3px 10px', borderRadius: 20, background: online ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.10)', color: online ? '#16a34a' : '#dc2626' }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: online ? '#16a34a' : '#dc2626' }} />
          {online ? 'Online' : 'Offline'}
        </span>
        <a href="/routers" style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 13 }}>← All routers</a>
      </div>
      {err && <div className="toast err" style={{ marginTop: 10 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', margin: '16px 0 20px', overflowX: 'auto' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 13.5, whiteSpace: 'nowrap',
              padding: '10px 14px', marginBottom: -1,
              borderBottom: tab === t.id ? '2px solid #e8590c' : '2px solid transparent',
              color: tab === t.id ? 'var(--text)' : 'var(--muted)', fontWeight: tab === t.id ? 700 : 500,
            }}
          >{t.icon} {t.label}</button>
        ))}
      </div>

      {tab === 'system' && (
        <div style={{ display: 'grid', gap: 20 }}>
          <section className="card">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>General Information</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 10 }}>
              <Field label="Management IP" value={sys?.system.management_ip} />
              <Field label="Username" value={sys?.system.username} />
              <Field label="Password" value={sys?.system.password} secret />
              <Field label="API Port" value={sys?.system.api_port} />
              <Field label="SSH Port" value={sys?.system.ssh_port} />
              <Field label="Serial Number" value={sys?.system.serial_number} />
              <Field label="VPN" value={sys?.system.vpn_status} />
              <Field label="Public Host" value={sys?.system.host} />
            </div>
          </section>
          <section className="card">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>RADIUS Configuration</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 10 }}>
              <Field label="RADIUS Server" value={sys?.radius.server} />
              <Field label="NAS IP" value={sys?.radius.nas_ip} />
              <Field label="Shared Secret" value={sys?.radius.secret} secret />
              <Field label="Auth Port" value={sys?.radius.auth_port} />
              <Field label="Accounting Port" value={sys?.radius.acct_port} />
            </div>
          </section>
          <section className="card">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Collection account</h3>
            <p className="sub" style={{ marginTop: 0 }}>
              Which paybill / till / bank account collects hotspot payments made through <strong>this</strong> router.
              Manage accounts in <a href="/settings">Settings → Payments</a>.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', maxWidth: 520 }}>
              <select
                value={router?.collection_account_id ?? ''}
                disabled={savingColl}
                onChange={(e) => assignCollAcct(e.target.value || null)}
                style={{ flex: 1, minWidth: 240 }}
              >
                <option value="">Use tenant default{defaultColl ? ` (${defaultColl.label})` : ''}</option>
                {collAccts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label} — {collDest(a)}</option>
                ))}
              </select>
              {savingColl && <span className="sub">Saving…</span>}
            </div>
            {!collAccts.length && <p className="sub" style={{ marginTop: 10 }}>No collection accounts defined yet — add them in Settings → Payments.</p>}
          </section>
        </div>
      )}

      {tab === 'users' && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              {['User', 'MAC', 'IP', 'Uptime', '↓ Down', '↑ Up'].map((h) => <th key={h} style={{ padding: '10px 12px' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {(users?.online ?? []).map((u, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{u.username || '—'}</td>
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>{u.mac || '—'}</td>
                  <td style={{ padding: '10px 12px' }}>{u.ip || '—'}</td>
                  <td style={{ padding: '10px 12px' }}>{uptime(u.acctsessiontime)}</td>
                  <td style={{ padding: '10px 12px' }}>{bytes(u.acctoutputoctets)}</td>
                  <td style={{ padding: '10px 12px' }}>{bytes(u.acctinputoctets)}</td>
                </tr>
              ))}
              {users && !users.online.length && <tr><td colSpan={6} style={{ padding: 16 }}><span className="sub">No users online right now.</span></td></tr>}
              {!users && <tr><td colSpan={6} style={{ padding: 16 }}><span className="sub">Loading…</span></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'reports' && (
        <div>
          {metrics && metrics.length ? (() => {
            const last = metrics[metrics.length - 1];
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
                <Stat label="Active sessions" value={last.active_sessions} />
                <Stat label="PPPoE" value={last.pppoe_sessions} />
                <Stat label="Hotspot" value={last.hotspot_sessions} />
                <Stat label="Down (sample)" value={bytes(last.total_bytes_in)} />
                <Stat label="Up (sample)" value={bytes(last.total_bytes_out)} />
                <Stat label="Tunnel" value={last.wg_up ? 'Up' : 'Down'} />
              </div>
            );
          })() : <p className="sub">{metrics ? 'No metrics sampled yet for this router.' : 'Loading…'}</p>}
        </div>
      )}

      {tab === 'events' && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              {['When', 'Event', 'Detail', 'By'].map((h) => <th key={h} style={{ padding: '10px 12px' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {(events ?? []).map((e) => {
                const [bg, color] = EVENT_STYLE[e.kind] || ['rgba(120,120,120,0.12)', 'var(--muted)'];
                return (
                  <tr key={e.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{when(e.created_at)}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 9px', borderRadius: 20, background: bg, color, textTransform: 'capitalize' }}>{e.kind}</span>
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>{e.detail || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>{e.actor || 'system'}</td>
                  </tr>
                );
              })}
              {events && !events.length && <tr><td colSpan={4} style={{ padding: 16 }}><span className="sub">No events yet — provisioning, config pushes and online/offline changes will appear here.</span></td></tr>}
              {!events && <tr><td colSpan={4} style={{ padding: 16 }}><span className="sub">Loading…</span></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'payments' && (
        <div style={{ display: 'grid', gap: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Stat label="Today" value={payments ? `KES ${payments.summary.today_kes.toLocaleString()}` : '—'} sub={payments ? `${payments.summary.today_count} payments` : ''} />
            <Stat label="This month" value={payments ? `KES ${payments.summary.month_kes.toLocaleString()}` : '—'} sub={payments ? `${payments.summary.month_count} payments` : ''} />
            <Stat label="All time" value={payments ? `KES ${payments.summary.total_kes.toLocaleString()}` : '—'} sub={payments ? `${payments.summary.total_count} payments` : ''} />
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                {['When', 'Phone', 'Plan', 'Amount', 'Status', 'Receipt'].map((h) => <th key={h} style={{ padding: '10px 12px' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(payments?.recent ?? []).map((p) => (
                  <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{when(p.completed_at || p.created_at)}</td>
                    <td style={{ padding: '10px 12px' }}>{p.phone || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>{p.plan_name || '—'}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>KES {Number(p.amount_kes).toLocaleString()}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ fontSize: 12, color: p.status === 'success' ? '#16a34a' : p.status === 'failed' ? '#dc2626' : 'var(--muted)' }}>{p.status}</span>
                    </td>
                    <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>{p.receipt || '—'}</td>
                  </tr>
                ))}
                {payments && !payments.recent.length && <tr><td colSpan={6} style={{ padding: 16 }}><span className="sub">No payments collected through this router yet.</span></td></tr>}
                {!payments && <tr><td colSpan={6} style={{ padding: 16 }}><span className="sub">Loading…</span></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'diagnosis' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="primary" onClick={runDiag} disabled={diagRunning}>{diagRunning ? 'Running checks…' : diag ? 'Re-run diagnostics' : 'Run diagnostics'}</button>
            <span className="sub">Live checks over the tunnel — tunnel liveness, RADIUS sessions, on-router CPU / memory / storage, RADIUS reachability.</span>
          </div>
          {diag && (
            <div className="card" style={{ display: 'grid', gap: 2 }}>
              {diag.checks.map((c) => (
                <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 6px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: DIAG_COLOR[c.status], width: 20, textAlign: 'center' }}>{DIAG_ICON[c.status]}</span>
                  <span style={{ fontWeight: 600, minWidth: 200 }}>{c.label}</span>
                  <span className="sub" style={{ marginLeft: 'auto', textAlign: 'right' }}>{c.detail}</span>
                </div>
              ))}
            </div>
          )}
          {!diag && !diagRunning && <p className="sub">Run diagnostics to check this router's health right now.</p>}
        </div>
      )}

      {tab === 'backups' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="primary" onClick={createBackup} disabled={backupBusy}>{backupBusy ? 'Capturing…' : '＋ Back up config now'}</button>
            <span className="sub">Captures a full RouterOS <code>/export</code> over the tunnel (sensitive values hidden) so you can review or restore a known-good config.</span>
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                {['When', 'Size', 'Note', 'By', ''].map((h, i) => <th key={i} style={{ padding: '10px 12px' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(backups ?? []).map((b) => (
                  <tr key={b.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{when(b.created_at)}</td>
                    <td style={{ padding: '10px 12px' }}>{bytes(b.size_bytes)}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>{b.note || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>{b.created_by || '—'}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="ghost" style={{ fontSize: 12, padding: '3px 9px' }} onClick={() => downloadBackup(b)}>⬇ Download</button>{' '}
                      <button className="ghost" style={{ fontSize: 12, padding: '3px 9px', color: '#dc2626' }} onClick={() => deleteBackup(b)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {backups && !backups.length && <tr><td colSpan={5} style={{ padding: 16 }}><span className="sub">No backups yet — capture one to keep a restorable copy of this router's config.</span></td></tr>}
                {!backups && <tr><td colSpan={5} style={{ padding: 16 }}><span className="sub">Loading…</span></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: any; sub?: string }) {
  return (
    <div className="card">
      <div className="sub" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value ?? '—'}</div>
      {sub ? <div className="sub" style={{ fontSize: 12 }}>{sub}</div> : null}
    </div>
  );
}
