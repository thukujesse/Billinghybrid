'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

export default function Vouchers() {
  const [plans, setPlans] = useState<any[]>([]);
  const [resellers, setResellers] = useState<any[]>([]);
  const [vouchers, setVouchers] = useState<any[]>([]);
  const [form, setForm] = useState({ plan_id: '', quantity: '10', prefix: '', reseller_id: '' });
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => {
    api('/plans').then(setPlans);
    api('/resellers').then(setResellers).catch(() => {});
    api('/vouchers').then(setVouchers).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const generate = async () => {
    try {
      const payload: any = { plan_id: form.plan_id, quantity: Number(form.quantity) };
      if (form.prefix) payload.prefix = form.prefix;
      if (form.reseller_id) payload.reseller_id = form.reseller_id;
      const r = await api('/vouchers/batch', { method: 'POST', body: JSON.stringify(payload) });
      setToast({ ok: true, msg: `Generated ${r.vouchers.length} vouchers (batch cost ${money(r.batch.cost_cents)})` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container">
      <h1>Vouchers</h1>
      <p className="sub">Batch generation (deducted from reseller balance) and redemption — the PHPNuxBill signature feature.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <div className="row">
          <div><label>Plan</label>
            <select value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })}>
              <option value="">Select plan…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price_cents)}</option>)}
            </select>
          </div>
          <div><label>Quantity</label><input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></div>
          <div><label>Prefix</label><input value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} placeholder="optional" /></div>
          <div><label>Reseller (optional)</label>
            <select value={form.reseller_id} onChange={(e) => setForm({ ...form, reseller_id: e.target.value })}>
              <option value="">House / admin</option>
              {resellers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}><button disabled={!form.plan_id} onClick={generate}>Generate batch</button></div>
        </div>
      </div>

      <h2>Latest vouchers ({vouchers.length})</h2>
      <table>
        <thead><tr><th>Code</th><th>Value</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>
          {vouchers.slice(0, 50).map((v) => (
            <tr key={v.id}>
              <td><code>{v.code}</code></td>
              <td>{money(v.value_cents)}</td>
              <td><span className={`badge ${v.status}`}>{v.status}</span></td>
              <td style={{ color: 'var(--muted)' }}>{new Date(v.created_at).toLocaleString()}</td>
            </tr>
          ))}
          {vouchers.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No vouchers yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
