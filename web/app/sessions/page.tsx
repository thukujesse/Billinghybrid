'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Session {
  id: string;
  username: string;
  nas_ip: string;
  framed_ip: string | null;
  start_time: string;
  session_time: number;
  bytes_in: number;
  bytes_out: number;
  caller_id: string | null;
  active: boolean;
}

export default function Sessions() {
  const [active, setActive] = useState<Session[]>([]);
  const [recent, setRecent] = useState<Session[]>([]);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => {
    api<Session[]>('/radius/sessions/active').then(setActive)
      .catch((e) => setToast({ ok: false, msg: e.message }));
    api<Session[]>('/radius/sessions/recent').then(setRecent).catch(() => {});
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="container">
      <h1>RADIUS Sessions</h1>
      <p className="sub">
        Live PPPoE / Hotspot authentications via central FreeRADIUS. Updates every 10 seconds.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card stat">
          <div className="label">Online now</div>
          <div className="value" style={{ color: 'var(--green)' }}>{active.length}</div>
        </div>
        <div className="card stat">
          <div className="label">Total traffic (online)</div>
          <div className="value">
            {formatBytes(active.reduce((s, x) => s + Number(x.bytes_in) + Number(x.bytes_out), 0))}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Recent sessions</div>
          <div className="value">{recent.length}</div>
        </div>
      </div>

      <h2>Active sessions</h2>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>NAS</th>
            <th>Framed IP</th>
            <th>Caller MAC</th>
            <th>Up</th>
            <th>Down</th>
            <th>Up</th>
          </tr>
        </thead>
        <tbody>
          {active.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.username}</strong></td>
              <td><code>{s.nas_ip}</code></td>
              <td><code>{s.framed_ip ?? '—'}</code></td>
              <td><code style={{ fontSize: 11 }}>{s.caller_id ?? '—'}</code></td>
              <td>{formatDuration(s.session_time)}</td>
              <td>{formatBytes(Number(s.bytes_in))}</td>
              <td>{formatBytes(Number(s.bytes_out))}</td>
            </tr>
          ))}
          {active.length === 0 && (
            <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>No active sessions</td></tr>
          )}
        </tbody>
      </table>

      <h2>Recent (last 50)</h2>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>NAS</th>
            <th>Framed IP</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Total</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.username}</strong></td>
              <td><code>{s.nas_ip}</code></td>
              <td><code>{s.framed_ip ?? '—'}</code></td>
              <td>{new Date(s.start_time).toLocaleString()}</td>
              <td>{formatDuration(s.session_time)}</td>
              <td>{formatBytes(Number(s.bytes_in) + Number(s.bytes_out))}</td>
              <td>
                <span className={`badge ${s.active ? 'active' : 'pending'}`}>
                  {s.active ? 'online' : 'closed'}
                </span>
              </td>
            </tr>
          ))}
          {recent.length === 0 && (
            <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>No sessions yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(sec: number): string {
  if (!sec) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}
