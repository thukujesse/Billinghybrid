'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Customer {
  id: string;
  account_number: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  status: string;
  created_at: string;
}

interface Service {
  id: string;
  service_type: string;
  username: string | null;
  rate_limit: string | null;
  status: string;
}

export default function Customers() {
  const [list, setList] = useState<Customer[]>([]);
  const [form, setForm] = useState({
    full_name: '', phone: '', email: '',
    username: '', password: '', rate_limit: '10M/10M',
  });
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () =>
    api<Customer[]>('/customers').then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setCreating(true);
    try {
      // Step 1: create the customer record.
      const customer = await api<Customer>('/customers', {
        method: 'POST',
        body: JSON.stringify({
          full_name: form.full_name,
          phone: form.phone || undefined,
          email: form.email || undefined,
        }),
      });
      // Step 2: add the PPPoE service (auto-inserts into radcheck/radreply).
      if (form.username && form.password) {
        await api<Service>(`/customers/${customer.id}/services`, {
          method: 'POST',
          body: JSON.stringify({
            service_type: 'pppoe',
            username: form.username,
            password: form.password,
            rate_limit: form.rate_limit || undefined,
          }),
        });
      }
      setToast({
        ok: true,
        msg: `Created ${customer.account_number} — ${form.username
          ? `PPPoE user "${form.username}" can now dial`
          : 'no service attached'}`,
      });
      setForm({ full_name: '', phone: '', email: '', username: '', password: '', rate_limit: '10M/10M' });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="container">
      <h1>Customers</h1>
      <p className="sub">
        One customer can own multiple services. Create a customer with a PPPoE
        service below — the username gets pushed to FreeRADIUS instantly.
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
            <label>Rate limit (up/down)</label>
            <input value={form.rate_limit} placeholder="10M/10M"
              onChange={(e) => setForm({ ...form, rate_limit: e.target.value })} />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button disabled={!form.full_name || creating} onClick={create}>
              {creating ? 'Creating…' : 'Create customer'}
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
            <th>Email</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td><code>{c.account_number}</code></td>
              <td><strong>{c.full_name}</strong></td>
              <td>{c.phone ?? '—'}</td>
              <td>{c.email ?? '—'}</td>
              <td>
                <span className={`badge ${
                  c.status === 'active' ? 'active' :
                  c.status === 'suspended' ? 'suspended' : 'pending'
                }`}>{c.status}</span>
              </td>
              <td>{new Date(c.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No customers yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
