'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface ActiveDevice {
  mac: string;
  expires_at: string;
  rate_limit: string | null;
  session_timeout_seconds: number;
  source: 'hotspot_purchase' | 'voucher' | 'admin' | 'rebind';
  phone: string | null;
  rebound_from_mac: string | null;
  first_seen: string;
  last_seen: string;
}

export default function ActiveDevices() {
  const [list, setList] = useState<ActiveDevice[]>([]);
  const [phoneFilter, setPhoneFilter] = useState('');
  const [includeExpired, setIncludeExpired] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => {
    const params = new URLSearchParams();
    if (!includeExpired) params.set('live', 'true');
    else params.set('live', 'false');
    if (phoneFilter.trim()) params.set('phone', phoneFilter.trim());
    api<ActiveDevice[]>(`/admin/active-devices?${params}`)
      .then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [includeExpired, phoneFilter]);

  const revoke = async (mac: string) => {
    if (!confirm(`Revoke grant for ${mac}? Customer will hit the captive portal on next connect.`)) return;
    try {
      await api(`/admin/active-devices/${encodeURIComponent(mac)}`, { method: 'DELETE' });
      setToast({ ok: true, msg: `Revoked ${mac}` });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    }
  };

  const live = list.filter((d) => new Date(d.expires_at) > new Date()).length;
  const rebound = list.filter((d) => d.rebound_from_mac).length;

  return (
    <div className="container">
      <h1>Active Devices</h1>
      <p className="sub">
        MAC-bound hotspot grants. Returning devices with a live grant skip
        the captive portal entirely. SMS-OTP rebinds appear here too, with
        the original MAC shown under "Rebound from".
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card stat">
          <div className="label">Live grants</div>
          <div className="value" style={{ color: 'var(--green)' }}>{live}</div>
        </div>
        <div className="card stat">
          <div className="label">Rebound (SMS-OTP)</div>
          <div className="value">{rebound}</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <div style={{ flex: '0 1 240px' }}>
          <label>Filter by phone</label>
          <input value={phoneFilter} placeholder="2547XXXXXXXX" onChange={(e) => setPhoneFilter(e.target.value)} />
        </div>
        <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input type="checkbox" checked={includeExpired} onChange={(e) => setIncludeExpired(e.target.checked)} style={{ width: 'auto' }} />
            Include expired
          </label>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>MAC</th>
            <th>Phone</th>
            <th>Source</th>
            <th>Rate</th>
            <th>Expires</th>
            <th>Last seen</th>
            <th>Rebound from</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((d) => {
            const exp = new Date(d.expires_at);
            const live = exp > new Date();
            return (
              <tr key={d.mac}>
                <td><code>{d.mac}</code></td>
                <td>{d.phone ? <code>{d.phone}</code> : '—'}</td>
                <td><span className={`badge ${d.source === 'rebind' ? 'pending' : 'active'}`}>{d.source}</span></td>
                <td style={{ fontSize: 12 }}>{d.rate_limit ?? '—'}</td>
                <td style={{ fontSize: 12, color: live ? 'inherit' : 'var(--muted)' }}>
                  {live ? relative(d.expires_at) : `expired ${relative(d.expires_at)}`}
                </td>
                <td style={{ fontSize: 12 }}>{relative(d.last_seen)}</td>
                <td>{d.rebound_from_mac ? <code style={{ fontSize: 11 }}>{d.rebound_from_mac}</code> : '—'}</td>
                <td>
                  {live && (
                    <button onClick={() => revoke(d.mac)} className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}>Revoke</button>
                  )}
                </td>
              </tr>
            );
          })}
          {list.length === 0 && (
            <tr><td colSpan={8} style={{ color: 'var(--muted)' }}>
              No devices match. Once a customer pays via hotspot and their MAC is captured, they appear here automatically.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function relative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const s = Math.round(ms / 1000);
  if (s > 86400) return `in ${Math.round(s / 86400)}d`;
  if (s > 3600) return `in ${Math.round(s / 3600)}h`;
  if (s > 60) return `in ${Math.round(s / 60)}m`;
  if (s > 5) return `in ${s}s`;
  if (s >= -60) return `${-s}s ago`;
  if (s >= -3600) return `${Math.round(-s / 60)}m ago`;
  if (s >= -86400) return `${Math.round(-s / 3600)}h ago`;
  return `${Math.round(-s / 86400)}d ago`;
}
