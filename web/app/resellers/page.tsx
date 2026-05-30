'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

export default function Resellers() {
  const [list, setList] = useState<any[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [form, setForm] = useState({ name: '', phone: '', commission: '10' });
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = async () => {
    const rs = await api('/resellers').catch(() => []);
    setList(rs);
    const b: Record<string, number> = {};
    await Promise.all(rs.map(async (r: any) => {
      const w = await api(`/resellers/${r.id}/wallet`).catch(() => ({ balance_cents: 0 }));
      b[r.id] = w.balance_cents ?? 0;
    }));
    setBalances(b);
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      await api('/resellers', { method: 'POST', body: JSON.stringify({ name: form.name, phone: form.phone || undefined, commission_bps: Math.round(Number(form.commission) * 100) }) });
      setToast({ ok: true, msg: 'Reseller created' });
      setForm({ name: '', phone: '', commission: '10' });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };
  const topup = async (id: string) => {
    const amt = prompt('Float top-up (KES):', '5000');
    if (!amt) return;
    try {
      await api(`/resellers/${id}/topup`, { method: 'POST', body: JSON.stringify({ amount_cents: Math.round(Number(amt) * 100) }) });
      setToast({ ok: true, msg: `Float added` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container">
      <h1>Resellers / Sub-dealers</h1>
      <p className="sub">Prepaid float model with commission tracking on voucher redemption.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <div className="row">
          <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div><label>Commission (%)</label><input value={form.commission} onChange={(e) => setForm({ ...form, commission: e.target.value })} /></div>
          <div style={{ flex: '0 0 auto' }}><button disabled={!form.name} onClick={create}>Add</button></div>
        </div>
      </div>

      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Commission</th><th>Float balance</th><th></th></tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.phone ?? '—'}</td>
              <td>{(r.commission_bps / 100).toFixed(1)}%</td>
              <td>{money(balances[r.id] ?? 0)}</td>
              <td><button className="ghost" onClick={() => topup(r.id)}>Add float</button></td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No resellers yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
