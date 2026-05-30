'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

export default function Subscribers() {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState({ full_name: '', phone: '', type: 'hotspot', email: '' });
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/subscribers').then(setList).catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const payload: any = { full_name: form.full_name, phone: form.phone, type: form.type };
      if (form.email) payload.email = form.email;
      await api('/subscribers', { method: 'POST', body: JSON.stringify(payload) });
      setToast({ ok: true, msg: 'Subscriber created' });
      setForm({ full_name: '', phone: '', type: 'hotspot', email: '' });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    setBusy(false);
  };

  const act = async (id: string, action: 'suspend' | 'restore') => {
    try {
      await api(`/subscribers/${id}/${action}`, { method: 'POST', body: '{}' });
      setToast({ ok: true, msg: `Subscriber ${action}d` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const topup = async (id: string) => {
    const amt = prompt('Top-up amount (KES):', '500');
    if (!amt) return;
    try {
      const { checkoutRequestId } = await api('/payments/mpesa/stk', {
        method: 'POST',
        body: JSON.stringify({ subscriber_id: id, amount_cents: Math.round(Number(amt) * 100) }),
      });
      // Simulated push: confirm immediately (in prod, Daraja calls the callback).
      await api('/payments/mpesa/callback', { method: 'POST', body: JSON.stringify({ checkout_request_id: checkoutRequestId, outcome: 'success' }) });
      setToast({ ok: true, msg: `M-Pesa top-up of KES ${amt} confirmed` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container">
      <h1>Subscribers</h1>
      <p className="sub">Hotspot &amp; PPPoE accounts. Suspend / restore pushes the action through Provisioning.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <div className="row">
          <div><label>Full name</label><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
          <div><label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="2547..." /></div>
          <div><label>Email</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label>Type</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="hotspot">Hotspot</option>
              <option value="pppoe">PPPoE</option>
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}><button disabled={busy || !form.full_name || !form.phone} onClick={create}>Add</button></div>
        </div>
      </div>

      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td>{s.full_name}</td>
              <td>{s.phone}</td>
              <td>{s.type}</td>
              <td><span className={`badge ${s.status}`}>{s.status}</span></td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="ghost" onClick={() => topup(s.id)}>Top-up</button>
                {s.status === 'suspended'
                  ? <button className="ghost" onClick={() => act(s.id, 'restore')}>Restore</button>
                  : <button className="ghost" onClick={() => act(s.id, 'suspend')}>Suspend</button>}
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No subscribers yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
