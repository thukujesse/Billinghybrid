'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

type Tab = 'system' | 'users' | 'reports' | 'events' | 'payments' | 'backups';
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'system', label: 'System Information', icon: '🖥' },
  { id: 'users', label: 'Internet Users', icon: '👥' },
  { id: 'reports', label: 'Reports', icon: '📊' },
  { id: 'events', label: 'Device Events', icon: '🔔' },
  { id: 'payments', label: 'Payments', icon: '💳' },
  { id: 'backups', label: 'Backups', icon: '🗄' },
];

interface RouterLite { id: string; name: string; status: string; vpn_status: string; host: string; site: string | null }
interface SystemInfo {
  system: Record<string, any>;
  radius: Record<string, any>;
}
interface Sessions { online: any[]; recent: any[] }

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
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (id) api<RouterLite>(`/routers/${id}`).then(setRouter).catch((e) => setErr(e.message)); }, [id]);
  useEffect(() => {
    if (!id) return;
    if (tab === 'system' && !sys) api<SystemInfo>(`/routers/${id}/system`).then(setSys).catch((e) => setErr(e.message));
    if (tab === 'users' && !users) api<Sessions>(`/routers/${id}/users`).then(setUsers).catch((e) => setErr(e.message));
    if (tab === 'reports' && !metrics) api<any[]>(`/routers/${id}/metrics?hours=24`).then(setMetrics).catch((e) => setErr(e.message));
  }, [id, tab, sys, users, metrics]);

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

      {tab === 'events' && <p className="sub">Device event log (online/offline, provisioning, config pushes) — coming next.</p>}
      {tab === 'payments' && <p className="sub">Payments collected via this router’s customers — coming next.</p>}
      {tab === 'backups' && <p className="sub">RouterOS config export + restore — coming next.</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="card">
      <div className="sub" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value ?? '—'}</div>
    </div>
  );
}
