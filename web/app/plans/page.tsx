'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

export default function Plans() {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', type: 'prepaid', price: '', validity_days: '30', data_cap_mb: '' });
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => api('/plans?all=true').then(setList).catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      const payload: any = {
        name: form.name,
        type: form.type,
        price_cents: Math.round(Number(form.price) * 100),
        validity_days: Number(form.validity_days),
      };
      if (form.data_cap_mb) payload.data_cap_mb = Number(form.data_cap_mb);
      if (form.type === 'postpaid') payload.billing_cycle = 'monthly';
      await api('/plans', { method: 'POST', body: JSON.stringify(payload) });
      setToast({ ok: true, msg: 'Plan created' });
      setForm({ name: '', type: 'prepaid', price: '', validity_days: '30', data_cap_mb: '' });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container">
      <h1>Plans &amp; Packages</h1>
      <p className="sub">Prepaid, postpaid and hotspot packages with validity, data caps and FUP.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <div className="row">
          <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Type</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="prepaid">Prepaid</option>
              <option value="postpaid">Postpaid</option>
              <option value="hotspot">Hotspot</option>
            </select>
          </div>
          <div><label>Price (KES)</label><input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></div>
          <div><label>Validity (days)</label><input value={form.validity_days} onChange={(e) => setForm({ ...form, validity_days: e.target.value })} /></div>
          <div><label>Data cap (MB, blank=∞)</label><input value={form.data_cap_mb} onChange={(e) => setForm({ ...form, data_cap_mb: e.target.value })} /></div>
          <div style={{ flex: '0 0 auto' }}><button disabled={!form.name || !form.price} onClick={create}>Add</button></div>
        </div>
      </div>

      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Price</th><th>Cycle</th><th>Validity</th><th>Data cap</th></tr></thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.type}</td>
              <td>{money(p.price_cents, p.currency)}</td>
              <td>{p.billing_cycle}</td>
              <td>{p.validity_days}d</td>
              <td>{p.data_cap_mb ? `${(p.data_cap_mb / 1024).toFixed(1)} GB` : '∞'}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No plans yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
