'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface RouterStatus {
  id: string;
  name: string;
  wg_tunnel_ip: string | null;
  last_handshake_at: string | null;
  wg_up: boolean;
  active_sessions: number;
  pppoe_sessions: number;
  hotspot_sessions: number;
  rate_bps_in: number | null;
  rate_bps_out: number | null;
  total_bytes_in: number;
  total_bytes_out: number;
}

interface LiveSession {
  username: string | null;
  framed_ip: string | null;
  nas_ip: string | null;
  router_name: string | null;
  service_type: string | null;
  acctstarttime: string | null;
  uptime_sec: number;
  bytes_in: number;
  bytes_out: number;
  customer_name: string | null;
  account_number: string | null;
}

interface TopConsumer {
  username: string;
  customer_name: string | null;
  account_number: string | null;
  bytes_total: number;
  session_count: number;
}

interface MetricsSample {
  sampled_at: string;
  total_bytes_in: number;
  total_bytes_out: number;
  active_sessions: number;
  wg_up: boolean;
  rate_bps_in: number | null;
  rate_bps_out: number | null;
}

function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatBps(n: number | null): string {
  if (n === null || n === undefined) return '—';
  // Bits per second is more idiomatic for network throughput than bytes.
  const bps = n * 8;
  if (bps < 1000) return `${bps.toFixed(0)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(0)} kbps`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
}

function formatDuration(sec: number): string {
  if (!sec) return '0s';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const past = Date.now() - new Date(iso).getTime();
  const s = Math.round(past / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Inline svg bandwidth chart — bytes-per-sec stacked (in + out) per sample.
function BandwidthChart({ samples }: { samples: MetricsSample[] }) {
  if (samples.length < 2) {
    return <p className="sub" style={{ fontSize: 11, margin: 0 }}>
      Collecting samples (sampler runs every 60s — need at least 2 to show throughput).
    </p>;
  }
  const w = 600, h = 100, pad = 22;
  const peak = Math.max(
    ...samples.map((s) => (s.rate_bps_in ?? 0) + (s.rate_bps_out ?? 0)),
    1
  );
  const stepX = (w - pad * 2) / (samples.length - 1);
  // Build polylines so the chart reads as area shapes for in vs out.
  const inPts = samples.map((s, i) => {
    const v = s.rate_bps_in ?? 0;
    const x = pad + i * stepX;
    const y = h - pad - ((h - pad * 2) * v) / peak;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const outPts = samples.map((s, i) => {
    const v = s.rate_bps_out ?? 0;
    const x = pad + i * stepX;
    const y = h - pad - ((h - pad * 2) * v) / peak;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'var(--surface, #f8fafc)', borderRadius: 6 }}>
      <text x={pad} y={12} fontSize="9" fill="#64748b">peak {formatBps(peak)}</text>
      <polyline points={`${pad},${h - pad} ${inPts} ${pad + (samples.length - 1) * stepX},${h - pad}`}
        fill="rgba(34,197,94,0.18)" stroke="#22c55e" strokeWidth={1.2} />
      <polyline points={`${pad},${h - pad} ${outPts} ${pad + (samples.length - 1) * stepX},${h - pad}`}
        fill="rgba(56,189,248,0.18)" stroke="#38bdf8" strokeWidth={1.2} />
    </svg>
  );
}

function RouterCard({ r }: { r: RouterStatus }) {
  const [hist, setHist] = useState<MetricsSample[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  const loadHist = () => {
    api<MetricsSample[]>(`/admin/network/routers/${r.id}/history?hours=6`)
      .then(setHist).catch(() => setHist([]));
  };

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 10, padding: 14, marginBottom: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: r.wg_up ? '#22c55e' : '#b91c1c',
              boxShadow: r.wg_up ? '0 0 4px #22c55e' : 'none',
            }} />
            {r.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            <code>{r.wg_tunnel_ip ?? '—'}</code>
            {' · '}WG handshake {relativeTime(r.last_handshake_at)}
          </div>
        </div>
        <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
          onClick={() => { setExpanded(!expanded); if (!hist) loadHist(); }}>
          {expanded ? 'Hide history' : 'History'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>Active</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{r.active_sessions}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>
            {r.pppoe_sessions} PPP · {r.hotspot_sessions} HS
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>↓ in</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e' }}>{formatBps(r.rate_bps_in)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>↑ out</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#38bdf8' }}>{formatBps(r.rate_bps_out)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>Total</div>
          <div style={{ fontSize: 13 }}>{formatBytes(r.total_bytes_in + r.total_bytes_out)}</div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {!hist ? <p className="sub" style={{ fontSize: 11 }}>Loading…</p> : <BandwidthChart samples={hist} />}
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#22c55e' }} /> Download</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#38bdf8' }} /> Upload</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function NetworkPage() {
  const [routers, setRouters] = useState<RouterStatus[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [topUsers, setTopUsers] = useState<TopConsumer[]>([]);
  const [routerFilter, setRouterFilter] = useState<string>('');
  const [windowMin, setWindowMin] = useState(60);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => {
    api<RouterStatus[]>('/admin/network/routers').then(setRouters).catch((e) => setToast({ ok: false, msg: e.message }));
    const sessParams = routerFilter ? `?router_id=${routerFilter}` : '';
    api<LiveSession[]>(`/admin/network/sessions${sessParams}`).then(setSessions).catch(() => {});
    api<TopConsumer[]>(`/admin/network/top-consumers?window_min=${windowMin}&limit=20`).then(setTopUsers).catch(() => {});
  };

  useEffect(() => {
    load();
    // Auto-refresh every 15s — the sampler tick is 60s but session/byte
    // counters update on every RADIUS interim-update (~1 min).
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [routerFilter, windowMin]);

  const totalActive = routers.reduce((a, r) => a + r.active_sessions, 0);
  const totalIn  = routers.reduce((a, r) => a + (r.rate_bps_in  ?? 0), 0);
  const totalOut = routers.reduce((a, r) => a + (r.rate_bps_out ?? 0), 0);
  const offlineCount = routers.filter((r) => !r.wg_up).length;

  return (
    <div className="container">
      <h1>Network monitoring</h1>
      <p className="sub">
        Live router state, current sessions, top bandwidth consumers.
        Auto-refreshes every 15 seconds. Sampler writes throughput history every 60 seconds.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="grid">
        <div className="card stat">
          <div className="label">Routers online</div>
          <div className="value" style={{ color: offlineCount > 0 ? '#b91c1c' : 'var(--green)' }}>
            {routers.length - offlineCount}/{routers.length}
          </div>
          {offlineCount > 0 && <div className="sub" style={{ margin: 0, color: '#b91c1c' }}>{offlineCount} offline</div>}
        </div>
        <div className="card stat">
          <div className="label">Active sessions</div>
          <div className="value">{totalActive}</div>
        </div>
        <div className="card stat">
          <div className="label">Throughput ↓</div>
          <div className="value" style={{ color: '#22c55e' }}>{formatBps(totalIn)}</div>
        </div>
        <div className="card stat">
          <div className="label">Throughput ↑</div>
          <div className="value" style={{ color: '#38bdf8' }}>{formatBps(totalOut)}</div>
        </div>
      </div>

      <h2 style={{ marginTop: 28 }}>Routers</h2>
      {routers.length === 0 ? (
        <p className="sub">No managed routers with a WireGuard tunnel yet.</p>
      ) : routers.map((r) => <RouterCard key={r.id} r={r} />)}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Live sessions</h2>
        <select value={routerFilter} onChange={(e) => setRouterFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All routers</option>
          {routers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Router</th>
            <th>IP</th>
            <th>Uptime</th>
            <th>↓ In</th>
            <th>↑ Out</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={`${s.username}-${s.acctstarttime}`}>
              <td>
                <code style={{ fontSize: 12 }}>{s.username ?? '—'}</code>
                {s.customer_name && (
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {s.customer_name} · {s.account_number}
                  </div>
                )}
              </td>
              <td style={{ fontSize: 12 }}>{s.router_name ?? <code>{s.nas_ip}</code>}</td>
              <td style={{ fontSize: 11 }}><code>{s.framed_ip ?? '—'}</code></td>
              <td style={{ fontSize: 12 }}>{formatDuration(s.uptime_sec)}</td>
              <td style={{ fontSize: 12 }}>{formatBytes(s.bytes_in)}</td>
              <td style={{ fontSize: 12 }}>{formatBytes(s.bytes_out)}</td>
              <td style={{ fontSize: 12, fontWeight: 600 }}>{formatBytes(s.bytes_in + s.bytes_out)}</td>
            </tr>
          ))}
          {sessions.length === 0 && (
            <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>No live sessions.</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Top bandwidth consumers</h2>
        <select value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))} style={{ width: 'auto' }}>
          <option value={15}>last 15 min</option>
          <option value={60}>last 1 hour</option>
          <option value={360}>last 6 hours</option>
          <option value={1440}>last 24 hours</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Customer</th>
            <th>Sessions</th>
            <th>Total bytes</th>
          </tr>
        </thead>
        <tbody>
          {topUsers.map((u) => (
            <tr key={u.username}>
              <td><code style={{ fontSize: 12 }}>{u.username}</code></td>
              <td style={{ fontSize: 12 }}>
                {u.customer_name ? (
                  <>{u.customer_name} <span style={{ color: 'var(--muted)' }}>· {u.account_number}</span></>
                ) : '—'}
              </td>
              <td style={{ fontSize: 12 }}>{u.session_count}</td>
              <td style={{ fontSize: 13, fontWeight: 600 }}>{formatBytes(u.bytes_total)}</td>
            </tr>
          ))}
          {topUsers.length === 0 && (
            <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No usage in this window.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
