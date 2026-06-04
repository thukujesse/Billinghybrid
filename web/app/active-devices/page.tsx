'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface DeviceRow {
  mac: string;
  expires_at: string;
  rate_limit: string | null;
  session_timeout_seconds: number;
  source: 'hotspot_purchase' | 'voucher' | 'admin' | 'rebind';
  phone: string | null;
  rebound_from_mac: string | null;
  first_seen: string;
  last_seen: string;
  // Joined from hotspot_purchases / plans by the listDevices query.
  plan_name: string | null;
  data_cap_mb: number | null;
  amount_kes: number | null;
  stk_status: 'pending' | 'success' | 'failed' | 'expired' | null;
  stk_receipt: string | null;
  stk_failure_reason: string | null;
  stk_created_at: string | null;
  stk_completed_at: string | null;
  user_agent: string | null;
  device_model: string;
  seconds_remaining: number;
  checkout_request_id: string | null;
}

export default function ActiveDevices() {
  const [list, setList] = useState<DeviceRow[]>([]);
  const [phoneFilter, setPhoneFilter] = useState('');
  const [includeExpired, setIncludeExpired] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [expandedUa, setExpandedUa] = useState<string | null>(null);

  const load = () => {
    const params = new URLSearchParams();
    params.set('live', includeExpired ? 'false' : 'true');
    if (phoneFilter.trim()) params.set('phone', phoneFilter.trim());
    api<DeviceRow[]>(`/admin/active-devices?${params}`)
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
  const pendingStk = list.filter((d) => d.stk_status === 'pending').length;
  const failedStk = list.filter((d) => d.stk_status === 'failed' || d.stk_status === 'expired').length;

  return (
    <div className="container">
      <h1>Hotspot Devices</h1>
      <p className="sub">
        Live MAC-bound grants with the M-Pesa purchase that produced each one.
        Phone, device model, STK status, package and time remaining at a glance.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card stat">
          <div className="label">Live grants</div>
          <div className="value" style={{ color: 'var(--green)' }}>{live}</div>
        </div>
        <div className="card stat">
          <div className="label">STK pending</div>
          <div className="value">{pendingStk}</div>
        </div>
        <div className="card stat">
          <div className="label">STK failed / expired</div>
          <div className="value" style={{ color: failedStk > 0 ? 'var(--red, #b91c1c)' : 'inherit' }}>{failedStk}</div>
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
            <th>Phone</th>
            <th>Device</th>
            <th>Package</th>
            <th>STK</th>
            <th>Amount</th>
            <th>Time left</th>
            <th>MAC</th>
            <th>Source</th>
            <th>Last seen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((d) => {
            const live = new Date(d.expires_at) > new Date();
            return (
              <tr key={d.mac}>
                <td>{d.phone ? <code>{d.phone}</code> : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td
                  style={{ fontSize: 12, cursor: d.user_agent ? 'pointer' : 'default' }}
                  title={d.user_agent ?? ''}
                  onClick={() => d.user_agent && setExpandedUa(expandedUa === d.mac ? null : d.mac)}
                >
                  {d.device_model}
                  {expandedUa === d.mac && d.user_agent && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, maxWidth: 280, whiteSpace: 'normal', wordBreak: 'break-all' }}>
                      {d.user_agent}
                    </div>
                  )}
                </td>
                <td style={{ fontSize: 12 }}>
                  {d.plan_name ? (
                    <>
                      <div><strong>{d.plan_name}</strong></div>
                      {d.data_cap_mb && (
                        <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                          {d.data_cap_mb >= 1024 ? `${(d.data_cap_mb / 1024).toFixed(1)} GB cap` : `${d.data_cap_mb} MB cap`}
                          {d.rate_limit ? ` · ${d.rate_limit}` : ''}
                        </div>
                      )}
                      {!d.data_cap_mb && d.rate_limit && (
                        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{d.rate_limit}</div>
                      )}
                    </>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>{d.source === 'voucher' ? 'Voucher' : '—'}</span>
                  )}
                </td>
                <td>
                  <StkBadge status={d.stk_status} reason={d.stk_failure_reason} receipt={d.stk_receipt} />
                </td>
                <td style={{ fontSize: 12 }}>{d.amount_kes ? `KES ${d.amount_kes}` : '—'}</td>
                <td style={{ fontSize: 12 }}>
                  {live ? (
                    <span style={{ color: d.seconds_remaining < 3600 ? 'var(--red, #b91c1c)' : 'inherit' }}>
                      {formatRemaining(d.seconds_remaining)}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>expired</span>
                  )}
                </td>
                <td><code style={{ fontSize: 11 }}>{d.mac}</code></td>
                <td>
                  <span className={`badge ${d.source === 'rebind' ? 'pending' : 'active'}`}>{d.source}</span>
                  {d.rebound_from_mac && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                      from <code>{d.rebound_from_mac}</code>
                    </div>
                  )}
                </td>
                <td style={{ fontSize: 12 }}>{relative(d.last_seen)}</td>
                <td>
                  {live && (
                    <button onClick={() => revoke(d.mac)} className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}>Revoke</button>
                  )}
                </td>
              </tr>
            );
          })}
          {list.length === 0 && (
            <tr><td colSpan={10} style={{ color: 'var(--muted)' }}>
              No devices match. Once a customer pays via hotspot and their MAC is captured, they appear here automatically.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StkBadge({
  status, reason, receipt,
}: { status: DeviceRow['stk_status']; reason: string | null; receipt: string | null }) {
  if (!status) return <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>;
  const colors: Record<NonNullable<DeviceRow['stk_status']>, { bg: string; fg: string }> = {
    pending: { bg: 'rgba(217,119,6,0.12)',  fg: '#a16207' },
    success: { bg: 'rgba(22,163,74,0.12)',  fg: '#15803d' },
    failed:  { bg: 'rgba(220,38,38,0.12)',  fg: '#b91c1c' },
    expired: { bg: 'rgba(100,116,139,0.12)', fg: '#475569' },
  };
  const c = colors[status];
  return (
    <span
      title={status === 'success' && receipt ? `Receipt: ${receipt}` : (reason ?? status)}
      style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}
    >
      {status}
    </span>
  );
}

function formatRemaining(s: number): string {
  if (s <= 0) return '0s';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
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