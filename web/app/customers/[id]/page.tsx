'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

interface Service {
  id: string;
  service_type: string;
  username: string | null;
  password: string | null;
  ip_address: string | null;
  mac_address: string | null;
  router_id: string | null;
  plan_id: string | null;
  rate_limit: string | null;
  status: 'active' | 'suspended' | 'expired' | 'cancelled';
  expiry_date: string | null;
  created_at: string;
  updated_at: string;
}

interface CustomerDetail {
  id: string;
  account_number: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: 'active' | 'suspended' | 'closed';
  notes: string | null;
  created_at: string;
  updated_at: string;
  notification_channels: Array<'sms' | 'email' | 'whatsapp'>;
  services: Service[];
}

interface Payment {
  id: string;
  source: 'hotspot_renewal' | 'hotspot_guest';
  checkout_request_id: string | null;
  amount_kes: number;
  status: 'pending' | 'success' | 'failed' | 'expired';
  receipt: string | null;
  failure_reason: string | null;
  service_id: string | null;
  service_username: string | null;
  plan_id: string | null;
  plan_name: string | null;
  created_at: string;
  completed_at: string | null;
}

interface Session {
  acctsessionid: string;
  acctstarttime: string | null;
  acctstoptime: string | null;
  framed_ip: string | null;
  nas_ip: string | null;
  acctinputoctets: string;
  acctoutputoctets: string;
  acctterminatecause: string | null;
}

interface AuditEntry {
  id: string;
  created_at: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  actor_label: string;
  actor_role: string;
  before: any;
  after: any;
  metadata: Record<string, unknown>;
}

interface WalletState {
  balance: { customer_id: string; balance_cents: number; updated_at: string };
  txns: Array<{
    id: string; kind: string; amount_cents: number; balance_after_cents: number;
    reference: string | null; notes: string | null; actor: string; created_at: string;
  }>;
}

interface Plan {
  id: string;
  name: string;
  price_cents: number;
  validity_days: number;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
}

function formatBytes(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const s = Math.round(ms / 1000);
  if (s <= 0) {
    const past = Math.abs(s);
    if (past < 60) return `${past}s ago`;
    if (past < 3600) return `${Math.round(past / 60)}m ago`;
    if (past < 86400) return `${Math.round(past / 3600)}h ago`;
    return `${Math.round(past / 86400)}d ago`;
  }
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const customerId = params.id;

  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [sessions, setSessions] = useState<Record<string, Session[]>>({});
  const [plans, setPlans] = useState<Plan[]>([]);
  const [activity, setActivity] = useState<AuditEntry[]>([]);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [adjust, setAdjust] = useState<{ amount: string; kind: 'adjustment' | 'refund'; notes: string } | null>(null);
  const [tab, setTab] = useState<'services' | 'payments' | 'sessions' | 'activity' | 'wallet'>('services');
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ full_name: '', phone: '', email: '', address: '', notes: '' });
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<CustomerDetail>(`/customers/${customerId}`)
      .then((c) => {
        setCustomer(c);
        setEditForm({
          full_name: c.full_name,
          phone: c.phone ?? '',
          email: c.email ?? '',
          address: c.address ?? '',
          notes: c.notes ?? '',
        });
      })
      .catch((e) => setToast({ ok: false, msg: e.message }));
    api<Payment[]>(`/customers/${customerId}/payments`)
      .then(setPayments)
      .catch(() => {/* non-fatal */});
    api<AuditEntry[]>(`/customers/${customerId}/audit?limit=100`)
      .then(setActivity)
      .catch(() => {/* non-fatal */});
    api<WalletState>(`/admin/customers/${customerId}/wallet`)
      .then(setWallet)
      .catch(() => {/* non-fatal — wallet may 404 if customer never had one */});
  };

  const submitAdjust = async () => {
    if (!adjust) return;
    const cents = Math.round(Number(adjust.amount) * 100);
    if (!Number.isFinite(cents) || cents === 0) {
      setToast({ ok: false, msg: 'Enter a non-zero KES amount (positive credit, negative debit).' });
      return;
    }
    setBusy(true);
    try {
      await api(`/admin/customers/${customerId}/wallet/adjust`, {
        method: 'POST',
        body: JSON.stringify({
          amount_cents: cents,
          kind: adjust.kind,
          notes: adjust.notes || undefined,
        }),
      });
      setToast({ ok: true, msg: `Wallet ${cents > 0 ? 'credited' : 'debited'} KES ${Math.abs(cents / 100).toFixed(0)}` });
      setAdjust(null);
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
    api<Plan[]>('/plans').then((all) => setPlans(all.filter((p) => p.price_cents > 0))).catch(() => {});
  }, [customerId]);

  const loadSessions = (serviceId: string) => {
    if (sessions[serviceId]) return;
    api<Session[]>(`/services/${serviceId}/sessions?limit=20`)
      .then((s) => setSessions((prev) => ({ ...prev, [serviceId]: s })))
      .catch(() => setSessions((prev) => ({ ...prev, [serviceId]: [] })));
  };

  useEffect(() => {
    if (tab === 'sessions' && customer) {
      customer.services.forEach((s) => loadSessions(s.id));
    }
  }, [tab, customer]);

  const saveEdit = async () => {
    setBusy(true);
    try {
      await api(`/customers/${customerId}`, {
        method: 'PUT',
        body: JSON.stringify({
          full_name: editForm.full_name,
          phone: editForm.phone || null,
          email: editForm.email || null,
          address: editForm.address || null,
          notes: editForm.notes || null,
        }),
      });
      setToast({ ok: true, msg: 'Customer updated' });
      setEditing(false);
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const setServiceStatus = async (svcId: string, status: 'active' | 'suspended') => {
    setBusy(true);
    try {
      await api(`/services/${svcId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setToast({ ok: true, msg: status === 'active' ? 'Restored' : 'Suspended' });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleChannel = async (channel: 'sms' | 'email' | 'whatsapp') => {
    if (!customer) return;
    const current = customer.notification_channels ?? [];
    const next = current.includes(channel)
      ? current.filter((c) => c !== channel)
      : [...current, channel];
    setBusy(true);
    try {
      await api(`/customers/${customerId}`, {
        method: 'PUT',
        body: JSON.stringify({ notification_channels: next }),
      });
      setToast({ ok: true, msg: `Channels: ${next.length ? next.join(', ') : 'opted out'}` });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const resendOnboardingSms = async (serviceId: string, username: string) => {
    if (!customer?.phone) {
      setToast({ ok: false, msg: 'No phone on file for this customer.' });
      return;
    }
    if (!confirm(`Resend the onboarding SMS for ${username} to ${customer.phone}?`)) return;
    setBusy(true);
    try {
      await api(`/admin/customers/${customerId}/services/${serviceId}/resend-onboarding`, { method: 'POST' });
      setToast({ ok: true, msg: `SMS resent to ${customer.phone}` });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const quickRenew = async (svc: Service) => {
    if (!confirm(`Renew ${svc.username}? This skips M-Pesa and bumps expiry by the plan's validity.`)) return;
    setBusy(true);
    try {
      await api(`/services/${svc.id}/renew`, {
        method: 'POST',
        body: JSON.stringify({ fromNow: svc.status !== 'active' }),
      });
      setToast({ ok: true, msg: `Renewed ${svc.username}` });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!customer) {
    return (
      <div className="container">
        {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}
        <p className="sub">Loading…</p>
      </div>
    );
  }

  return (
    <div className="container">
      <p className="sub" style={{ marginBottom: 8 }}>
        <a href="/customers" style={{ color: 'inherit' }}>← Customers</a>
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{customer.full_name}</h1>
          <p className="sub" style={{ margin: 0 }}>
            <code>{customer.account_number}</code> · created {new Date(customer.created_at).toLocaleDateString()}
            {' · '}<span className={`badge ${customer.status === 'active' ? 'active' : 'suspended'}`}>{customer.status}</span>
          </p>
        </div>
        {!editing && (
          <button className="ghost" onClick={() => setEditing(true)}>Edit details</button>
        )}
      </div>

      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`} style={{ margin: '12px 0' }}>{toast.msg}</div>}

      {editing ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row">
            <div>
              <label>Full name</label>
              <input value={editForm.full_name} onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })} />
            </div>
            <div>
              <label>Phone</label>
              <input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
            </div>
            <div>
              <label>Email</label>
              <input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            </div>
          </div>
          <label style={{ marginTop: 12 }}>Address</label>
          <input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
          <label>Notes</label>
          <textarea value={editForm.notes} rows={3}
            onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
            style={{ width: '100%', fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={saveEdit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <table style={{ fontSize: 13 }}>
            <tbody>
              <tr><td style={{ color: 'var(--muted)', width: 110 }}>Phone</td><td>{customer.phone ?? '—'}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Email</td><td>{customer.email ?? '—'}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Address</td><td>{customer.address ?? '—'}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Notes</td><td style={{ whiteSpace: 'pre-wrap' }}>{customer.notes ?? '—'}</td></tr>
              <tr>
                <td style={{ color: 'var(--muted)' }}>Notifications</td>
                <td>
                  {(['sms','email','whatsapp'] as const).map((ch) => {
                    const on = (customer.notification_channels ?? []).includes(ch);
                    return (
                      <button key={ch} disabled={busy}
                        onClick={() => toggleChannel(ch)}
                        className={on ? '' : 'ghost'}
                        style={{ fontSize: 11, padding: '4px 10px', marginRight: 6, textTransform: 'uppercase', opacity: busy ? 0.5 : 1 }}>
                        {ch}
                      </button>
                    );
                  })}
                  {(customer.notification_channels ?? []).length === 0 && (
                    <span style={{ fontSize: 11, color: 'var(--red, #b91c1c)', marginLeft: 6 }}>
                      Opted out
                    </span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 24, borderBottom: '1px solid var(--border, #e2e8f0)' }}>
        {(['services', 'payments', 'sessions', 'activity', 'wallet'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              border: 'none',
              borderBottom: tab === t ? '2px solid var(--brand, #2563eb)' : '2px solid transparent',
              marginBottom: -1,
              color: tab === t ? 'var(--brand, #2563eb)' : 'var(--muted, #64748b)',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            {t === 'services' && `Services (${customer.services.length})`}
            {t === 'payments' && `Payments (${payments.length})`}
            {t === 'sessions' && 'Sessions'}
            {t === 'activity' && `Activity (${activity.length})`}
            {t === 'wallet'   && `Wallet${wallet ? ` (KES ${(wallet.balance.balance_cents / 100).toFixed(0)})` : ''}`}
          </button>
        ))}
      </div>

      {tab === 'services' && (
        <div style={{ marginTop: 16 }}>
          {customer.services.length === 0 ? (
            <p className="sub">No services yet.</p>
          ) : customer.services.map((s) => {
            const exp = s.expiry_date ? new Date(s.expiry_date) : null;
            const planName = plans.find((p) => p.id === s.plan_id)?.name ?? '—';
            return (
              <div key={s.id} className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>
                      <code>{s.username ?? '—'}</code>
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>{s.service_type}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      {planName} · {s.rate_limit ?? 'no rate'} · expires {exp ? exp.toLocaleString() : '—'}
                      {exp && <span style={{ marginLeft: 8 }}>({formatRelative(s.expiry_date)})</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span className={`badge ${s.status === 'active' ? 'active' : s.status === 'suspended' ? 'suspended' : 'pending'}`}>
                      {s.status}
                    </span>
                  </div>
                </div>
                {s.password && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                    PPPoE password: <code>{s.password}</code>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                  <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                    disabled={busy} onClick={() => quickRenew(s)}>Renew</button>
                  {s.status === 'active' ? (
                    <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                      disabled={busy} onClick={() => setServiceStatus(s.id, 'suspended')}>Suspend</button>
                  ) : (
                    <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                      disabled={busy} onClick={() => setServiceStatus(s.id, 'active')}>Restore</button>
                  )}
                  {s.username && s.password && (
                    <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                      disabled={busy} onClick={() => resendOnboardingSms(s.id, s.username!)}>
                      Resend creds SMS
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'payments' && (
        <div style={{ marginTop: 16 }}>
          {payments.length === 0 ? (
            <p className="sub">No payments on record.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontSize: 12 }}>{new Date(p.created_at).toLocaleString()}</td>
                    <td style={{ fontSize: 12 }}>
                      {p.source === 'hotspot_renewal' ? 'PPPoE renewal' : 'Hotspot guest'}
                      {p.service_username && <div style={{ color: 'var(--muted)', fontSize: 11 }}><code>{p.service_username}</code></div>}
                    </td>
                    <td style={{ fontSize: 12 }}>{p.plan_name ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>KES {p.amount_kes}</td>
                    <td>
                      <span className={`badge ${
                        p.status === 'success' ? 'active' :
                        p.status === 'pending' ? 'pending' : 'suspended'
                      }`}>{p.status}</span>
                      {p.failure_reason && (
                        <div style={{ fontSize: 10, color: 'var(--red, #b91c1c)', marginTop: 2 }}>{p.failure_reason}</div>
                      )}
                    </td>
                    <td style={{ fontSize: 11 }}>{p.receipt ? <code>{p.receipt}</code> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'sessions' && (
        <div style={{ marginTop: 16 }}>
          {customer.services.filter((s) => s.username).length === 0 ? (
            <p className="sub">No PPPoE / hotspot services to show sessions for.</p>
          ) : customer.services.filter((s) => s.username).map((s) => (
            <div key={s.id} style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>
                <code>{s.username}</code>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>{s.service_type}</span>
              </h3>
              {!sessions[s.id] ? (
                <p className="sub">Loading sessions…</p>
              ) : sessions[s.id].length === 0 ? (
                <p className="sub">No sessions on record.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Duration</th>
                      <th>IP</th>
                      <th>Down</th>
                      <th>Up</th>
                      <th>Ended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions[s.id].map((sess) => (
                      <tr key={sess.acctsessionid}>
                        <td style={{ fontSize: 12 }}>{sess.acctstarttime ? new Date(sess.acctstarttime).toLocaleString() : '—'}</td>
                        <td style={{ fontSize: 12 }}>{formatDuration(sess.acctstarttime, sess.acctstoptime)}</td>
                        <td style={{ fontSize: 11 }}><code>{sess.framed_ip ?? '—'}</code></td>
                        <td style={{ fontSize: 12 }}>{formatBytes(sess.acctinputoctets)}</td>
                        <td style={{ fontSize: 12 }}>{formatBytes(sess.acctoutputoctets)}</td>
                        <td style={{ fontSize: 11, color: 'var(--muted)' }}>
                          {sess.acctstoptime ? (
                            <>
                              {new Date(sess.acctstoptime).toLocaleString()}
                              {sess.acctterminatecause && <div style={{ fontSize: 10 }}>{sess.acctterminatecause}</div>}
                            </>
                          ) : <span style={{ color: 'var(--green, #15803d)' }}>● live</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'activity' && (
        <div style={{ marginTop: 16 }}>
          {activity.length === 0 ? (
            <p className="sub">No audited activity for this customer yet.</p>
          ) : activity.map((e) => (
            <div key={e.id} style={{
              background: 'var(--card-2)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 12, marginBottom: 8, fontSize: 13,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <code style={{ fontSize: 11, background: 'rgba(37,99,235,0.08)', color: '#1d4ed8', padding: '2px 6px', borderRadius: 4 }}>
                    {e.kind}
                  </code>
                  <span style={{ marginLeft: 8, color: 'var(--muted)', fontSize: 12 }}>
                    by <strong style={{ color: '#0f172a' }}>{e.actor_label}</strong> ({e.actor_role})
                  </span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </div>
              {(e.before || e.after) && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>
                  {e.before && Object.keys(e.before).length > 0 && (
                    <div>before: <span style={{ color: '#b91c1c' }}>{JSON.stringify(e.before)}</span></div>
                  )}
                  {e.after && Object.keys(e.after).length > 0 && (
                    <div>after: <span style={{ color: '#15803d' }}>{JSON.stringify(e.after)}</span></div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'wallet' && (
        <div style={{ marginTop: 16 }}>
          {!wallet ? (
            <p className="sub">Loading wallet…</p>
          ) : (
            <>
              <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Balance</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: '#2563eb' }}>
                    KES {(wallet.balance.balance_cents / 100).toFixed(0)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    Updated {new Date(wallet.balance.updated_at).toLocaleString()}
                  </div>
                </div>
                <button onClick={() => setAdjust({ amount: '', kind: 'adjustment', notes: '' })}>
                  Adjust balance
                </button>
              </div>

              <h3 style={{ fontSize: 14 }}>Transaction history</h3>
              {wallet.txns.length === 0 ? (
                <p className="sub">No wallet activity yet.</p>
              ) : (
                <table>
                  <thead><tr><th>When</th><th>Kind</th><th>Amount</th><th>Balance</th><th>By</th><th>Notes</th></tr></thead>
                  <tbody>
                    {wallet.txns.map((t) => {
                      const amt = t.amount_cents / 100;
                      const credit = amt > 0;
                      return (
                        <tr key={t.id}>
                          <td style={{ fontSize: 11 }}>{new Date(t.created_at).toLocaleString()}</td>
                          <td><span className="badge">{t.kind}</span></td>
                          <td style={{ fontWeight: 600, color: credit ? '#15803d' : '#b91c1c' }}>
                            {credit ? '+' : ''}KES {amt.toFixed(0)}
                          </td>
                          <td>KES {(t.balance_after_cents / 100).toFixed(0)}</td>
                          <td style={{ fontSize: 11 }}>{t.actor}</td>
                          <td style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {t.reference}{t.reference && t.notes ? ' · ' : ''}{t.notes}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}

      {adjust && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setAdjust(null)}>
          <div style={{
            background: 'var(--card)', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%',
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Adjust wallet balance</h3>
            <p className="sub">
              Use positive amount to credit (cash received, promo) and negative to debit
              (correction, fee). The adjustment shows up in the customer's wallet history.
            </p>

            <label>Amount (KES) — negative to debit</label>
            <input type="number" value={adjust.amount}
              onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })}
              placeholder="e.g. 1500 or -200" />

            <label>Kind</label>
            <select value={adjust.kind}
              onChange={(e) => setAdjust({ ...adjust, kind: e.target.value as any })}>
              <option value="adjustment">Adjustment (correction / promo)</option>
              <option value="refund">Refund</option>
            </select>

            <label>Notes (optional)</label>
            <input value={adjust.notes}
              onChange={(e) => setAdjust({ ...adjust, notes: e.target.value })}
              placeholder="Cash payment at Nakuru office" />

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={submitAdjust} disabled={busy || !adjust.amount}>
                {busy ? 'Saving…' : 'Confirm adjustment'}
              </button>
              <button className="ghost" onClick={() => setAdjust(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}