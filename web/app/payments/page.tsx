'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

export default function Payments() {
  const [list, setList] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = async () => {
    const pays = await api('/payments').catch((e) => { setToast({ ok: false, msg: e.message }); return []; });
    setList(pays);
    const all = await api('/refunds').catch(() => []);
    const byPayment: Record<string, number> = {};
    for (const r of all) byPayment[r.payment_id] = (byPayment[r.payment_id] ?? 0) + Number(r.amount_cents);
    setRefunds(byPayment);
  };
  useEffect(() => { load(); }, []);

  const refund = async (p: any) => {
    const refunded = refunds[p.id] ?? 0;
    const remaining = p.amount_cents - refunded;
    const amt = prompt(`Refund amount (KES). Remaining refundable: ${(remaining / 100).toFixed(2)}`, (remaining / 100).toString());
    if (!amt) return;
    const method = prompt('Method: wallet / mpesa / manual', 'wallet') ?? 'wallet';
    try {
      await api('/refunds', { method: 'POST', body: JSON.stringify({ payment_id: p.id, amount_cents: Math.round(Number(amt) * 100), method, reason: 'admin refund' }) });
      setToast({ ok: true, msg: 'Refund processed' });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container">
      <h1>Payments</h1>
      <p className="sub">All transactions with refund workflows (full or partial; wallet / M-Pesa / manual).</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <table>
        <thead><tr><th>Provider</th><th>Amount</th><th>Refunded</th><th>Status</th><th>When</th><th></th></tr></thead>
        <tbody>
          {list.map((p) => {
            const refunded = refunds[p.id] ?? 0;
            return (
              <tr key={p.id}>
                <td>{p.provider}</td>
                <td>{money(p.amount_cents)}</td>
                <td>{refunded ? money(refunded) : '—'}</td>
                <td><span className={`badge ${p.status}`}>{p.status}</span></td>
                <td style={{ color: 'var(--muted)' }}>{new Date(p.created_at).toLocaleString()}</td>
                <td>{p.status === 'success' && refunded < p.amount_cents && <button className="ghost" onClick={() => refund(p)}>Refund</button>}</td>
              </tr>
            );
          })}
          {list.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No payments yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
