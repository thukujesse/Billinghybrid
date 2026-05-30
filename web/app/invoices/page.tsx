'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

export default function Invoices() {
  const [list, setList] = useState<any[]>([]);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => api('/invoices').then(setList).catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => { load(); }, []);

  const runCycle = async () => {
    try {
      const r = await api('/billing/run-cycle', { method: 'POST', body: '{}' });
      setToast({ ok: true, msg: `Billing cycle: ${r.invoiced} invoiced, ${r.paid} paid, ${r.unpaid} unpaid` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };
  const runDunning = async () => {
    try {
      const r = await api('/billing/run-dunning', { method: 'POST', body: '{}' });
      setToast({ ok: true, msg: `Dunning: ${r.retried} retried, ${r.suspended} suspended` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };
  const charge = async (id: string) => {
    try {
      const r = await api(`/invoices/${id}/charge`, { method: 'POST', body: '{}' });
      setToast({ ok: r.paid, msg: r.paid ? 'Invoice paid from wallet' : `Not paid: ${r.reason}` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };
  const creditNote = async (inv: any) => {
    const amt = prompt(`Credit note amount (KES). Invoice total: ${(inv.total_cents / 100).toFixed(2)}`, (inv.total_cents / 100).toString());
    if (!amt) return;
    const reason = prompt('Reason', 'adjustment') ?? 'adjustment';
    try {
      await api('/credit-notes', { method: 'POST', body: JSON.stringify({ subscriber_id: inv.subscriber_id, invoice_id: inv.id, amount_cents: Math.round(Number(amt) * 100), reason }) });
      setToast({ ok: true, msg: 'Credit note issued (wallet credited)' });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container">
      <h1>Invoices</h1>
      <p className="sub">Postpaid billing with VAT, wallet settlement and the dunning engine.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button onClick={runCycle}>Run billing cycle</button>
        <button className="ghost" onClick={runDunning}>Run dunning</button>
      </div>

      <table>
        <thead><tr><th>Number</th><th>Subtotal</th><th>Tax</th><th>Total</th><th>Status</th><th>Dunning</th><th>Due</th><th></th></tr></thead>
        <tbody>
          {list.map((i) => (
            <tr key={i.id}>
              <td><code>{i.number}</code></td>
              <td>{money(i.subtotal_cents)}</td>
              <td>{money(i.tax_cents)}</td>
              <td>{money(i.total_cents)}</td>
              <td><span className={`badge ${i.status}`}>{i.status}</span></td>
              <td>{i.dunning_attempts}</td>
              <td style={{ color: 'var(--muted)' }}>{new Date(i.due_date).toLocaleDateString()}</td>
              <td style={{ display: 'flex', gap: 6 }}>
                {i.status !== 'paid' && <button className="ghost" onClick={() => charge(i.id)}>Charge</button>}
                <button className="ghost" onClick={() => creditNote(i)}>Credit</button>
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={8} style={{ color: 'var(--muted)' }}>No invoices yet — run the billing cycle</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
