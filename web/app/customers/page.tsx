'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface ServiceSummary {
  id: string;
  service_type: string;
  username: string | null;
  rate_limit: string | null;
  status: string;
}

interface Customer {
  id: string;
  account_number: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  status: string;
  created_at: string;
  services: ServiceSummary[];
}

export default function Customers() {
  const [list, setList] = useState<Customer[]>([]);
  const [form, setForm] = useState({
    full_name: '', phone: '', email: '',
    username: '', password: '', rate_limit: '10M/10M',
  });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () =>
    api<Customer[]>('/customers').then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const customer = await api<Customer>('/customers', {
        method: 'POST',
        body: JSON.stringify({
          full_name: form.full_name,
          phone: form.phone || undefined,
          email: form.email || undefined,
        }),
      });
      if (form.username && form.password) {
        await api(`/customers/${customer.id}/services`, {
          method: 'POST',
          body: JSON.stringify({
            service_type: 'pppoe',
            username: form.username,
            password: form.password,
            rate_limit: form.rate_limit || undefined,
          }),
        });
      }
      setToast({ ok: true, msg: `Created ${customer.account_number}` });
      setForm({ full_name: '', phone: '', email: '', username: '', password: '', rate_limit: '10M/10M' });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setCreating(false);
    }
  };

  const setStatus = async (svc: ServiceSummary, status: string) => {
    setBusy(svc.id);
    try {
      await api(`/services/${svc.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setToast({
        ok: true,
        msg: status === 'active'
          ? `Restored ${svc.username} — can re-dial now`
          : `Suspended ${svc.username} — active session kicked via CoA`,
      });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="container">
      <h1>Customers</h1>
      <p className="sub">
        Suspend kicks the live session immediately (RADIUS CoA). Restore lets the
        customer re-dial. All sync to FreeRADIUS instantly — no manual SQL.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>New customer + PPPoE service</h3>
        <div className="row">
          <div>
            <label>Full name *</label>
            <input value={form.full_name} placeholder="Jane Wanjiku"
              onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          </div>
          <div>
            <label>Phone</label>
            <input value={form.phone} placeholder="+2547..."
              onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label>Email</label>
            <input value={form.email} placeholder="jane@example.com"
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
        </div>
        <h4 style={{ marginTop: 20, color: 'var(--muted)' }}>PPPoE service (optional)</h4>
        <div className="row">
          <div>
            <label>Username</label>
            <input value={form.username} placeholder="jwanjiku"
              onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div>
            <label>Password</label>
            <input value={form.password} placeholder="strong password"
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div>
            <label>Rate limit</label>
            <input value={form.rate_limit} placeholder="10M/10M"
              onChange={(e) => setForm({ ...form, rate_limit: e.target.value })} />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button disabled={!form.full_name || creating} onClick={create}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Service</th>
            <th>Rate</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {list.flatMap((c) => {
            if (c.services.length === 0) {
              return [(
                <tr key={c.id}>
                  <td><code>{c.account_number}</code></td>
                  <td><strong>{c.full_name}</strong></td>
                  <td>{c.phone ?? '—'}</td>
                  <td colSpan={4} style={{ color: 'var(--muted)' }}>no service</td>
                </tr>
              )];
            }
            return c.services.map((s, i) => (
              <tr key={s.id}>
                {i === 0 ? <td rowSpan={c.services.length}><code>{c.account_number}</code></td> : null}
                {i === 0 ? <td rowSpan={c.services.length}><strong>{c.full_name}</strong></td> : null}
                {i === 0 ? <td rowSpan={c.services.length}>{c.phone ?? '—'}</td> : null}
                <td>
                  <code>{s.username ?? '—'}</code>
                  <small style={{ color: 'var(--muted)', marginLeft: 6 }}>{s.service_type}</small>
                </td>
                <td>{s.rate_limit ?? '—'}</td>
                <td>
                  <span className={`badge ${
                    s.status === 'active' ? 'active' :
                    s.status === 'suspended' ? 'suspended' : 'pending'
                  }`}>{s.status}</span>
                </td>
                <td>
                  {s.status === 'active' ? (
                    <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                            disabled={busy === s.id}
                            onClick={() => setStatus(s, 'suspended')}>
                      {busy === s.id ? '…' : 'Suspend'}
                    </button>
                  ) : (
                    <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                            disabled={busy === s.id}
                            onClick={() => setStatus(s, 'active')}>
                      {busy === s.id ? '…' : 'Restore'}
                    </button>
                  )}
                </td>
              </tr>
            ));
          })}
          {list.length === 0 && (
            <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>No customers yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
