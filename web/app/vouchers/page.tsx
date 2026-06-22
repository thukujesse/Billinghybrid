'use client';
import { useEffect, useMemo, useState } from 'react';
import { api, money } from '@/lib/api';

interface Voucher {
  id: string; code: string; value_cents: number; status: string;
  created_at: string; expires_at?: string | null;
}
interface GeneratedBatch {
  vouchers: Voucher[]; planName: string; cost_cents: number;
}

// Codes are alphanumeric, but plan names are operator input — escape before
// injecting into the print window's HTML.
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function Vouchers() {
  const [plans, setPlans] = useState<any[]>([]);
  const [resellers, setResellers] = useState<any[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [form, setForm] = useState({ plan_id: '', quantity: '10', prefix: '', reseller_id: '' });
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastBatch, setLastBatch] = useState<GeneratedBatch | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');

  const load = () => {
    api('/plans').then(setPlans);
    api('/resellers').then(setResellers).catch(() => {});
    api<Voucher[]>('/vouchers').then(setVouchers).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const generate = async () => {
    setBusy(true);
    try {
      const payload: any = { plan_id: form.plan_id, quantity: Number(form.quantity) };
      if (form.prefix) payload.prefix = form.prefix;
      if (form.reseller_id) payload.reseller_id = form.reseller_id;
      const r = await api<{ vouchers: Voucher[]; batch: { cost_cents: number } }>('/vouchers/batch', {
        method: 'POST', body: JSON.stringify(payload),
      });
      const planName = plans.find((p) => p.id === form.plan_id)?.name ?? 'Voucher';
      setLastBatch({ vouchers: r.vouchers, planName, cost_cents: r.batch.cost_cents });
      setToast({ ok: true, msg: `Generated ${r.vouchers.length} vouchers (batch cost ${money(r.batch.cost_cents)})` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };

  // Open a print-friendly window of the just-generated batch as voucher cards.
  const printSheet = () => {
    if (!lastBatch) return;
    const { vouchers: vs, planName } = lastBatch;
    const cards = vs.map((v) => `
      <div class="vc">
        <div class="plan">${esc(planName)}</div>
        <div class="code">${esc(v.code)}</div>
        <div class="val">${money(v.value_cents)}</div>
        ${v.expires_at ? `<div class="exp">expires ${esc(new Date(v.expires_at).toLocaleDateString())}</div>` : ''}
      </div>`).join('');
    const w = window.open('', '_blank', 'width=820,height=920');
    if (!w) { setToast({ ok: false, msg: 'Popup blocked — allow popups to print the sheet.' }); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Vouchers — ${esc(planName)}</title>
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;margin:18px;color:#111;}
        h1{font-size:15px;margin:0 0 12px;}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
        .vc{border:1px dashed #999;border-radius:8px;padding:14px 10px;text-align:center;page-break-inside:avoid;}
        .plan{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.6px;}
        .code{font-family:ui-monospace,Menlo,monospace;font-size:21px;font-weight:700;letter-spacing:1px;margin:7px 0;}
        .val{font-size:13px;font-weight:600;}
        .exp{font-size:10px;color:#888;margin-top:4px;}
        @media print{.noprint{display:none;}}
      </style></head><body>
      <div class="noprint" style="margin-bottom:12px;">
        <button onclick="window.print()" style="padding:6px 14px;font-size:13px;">Print</button>
        &nbsp;${vs.length} vouchers · ${esc(planName)}
      </div>
      <div class="grid">${cards}</div>
      </body></html>`);
    w.document.close();
  };

  const downloadCsv = () => {
    if (!lastBatch) return;
    const header = ['code', 'value_kes', 'plan', 'expires_at'];
    const rows = lastBatch.vouchers.map((v) => [
      v.code, String(Math.round(v.value_cents / 100)), lastBatch.planName, v.expires_at ?? '',
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vouchers-${lastBatch.planName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyCodes = async () => {
    if (!lastBatch) return;
    try {
      await navigator.clipboard.writeText(lastBatch.vouchers.map((v) => v.code).join('\n'));
      setToast({ ok: true, msg: `${lastBatch.vouchers.length} codes copied` });
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  // Status filter + counts over the recent list.
  const statuses = useMemo(() => {
    const set = new Set(vouchers.map((v) => v.status));
    return ['all', ...Array.from(set).sort()];
  }, [vouchers]);
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: vouchers.length };
    for (const v of vouchers) m[v.status] = (m[v.status] ?? 0) + 1;
    return m;
  }, [vouchers]);
  const shown = statusFilter === 'all' ? vouchers : vouchers.filter((v) => v.status === statusFilter);

  return (
    <div className="container">
      <h1>Vouchers</h1>
      <p className="sub">Batch generation (deducted from reseller balance), printable sheets, and redemption — the PHPNuxBill signature feature.</p>
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
          <div style={{ flex: '0 0 auto' }}>
            <button disabled={!form.plan_id || busy} onClick={generate}>{busy ? 'Generating…' : 'Generate batch'}</button>
          </div>
        </div>
      </div>

      {lastBatch && (
        <div className="card" style={{ borderColor: 'var(--brand, #2563eb)', marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <strong>{lastBatch.vouchers.length} vouchers ready</strong>
              <span className="sub"> · {lastBatch.planName} · batch cost {money(lastBatch.cost_cents)}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={printSheet}>🖨 Print sheet</button>
              <button className="ghost" onClick={downloadCsv}>Download CSV</button>
              <button className="ghost" onClick={copyCodes}>Copy codes</button>
              <button className="ghost" onClick={() => setLastBatch(null)}>Dismiss</button>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {lastBatch.vouchers.map((v) => (
              <code key={v.id} style={{ background: 'var(--card-2, rgba(0,0,0,0.05))', padding: '3px 8px', borderRadius: 5, fontSize: 13 }}>{v.code}</code>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 24, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Recent vouchers ({shown.length})</h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {statuses.map((s) => (
            <button key={s} className={statusFilter === s ? '' : 'ghost'}
              style={{ fontSize: 11, padding: '4px 10px', textTransform: 'capitalize' }}
              onClick={() => setStatusFilter(s)}>
              {s} ({counts[s] ?? 0})
            </button>
          ))}
        </div>
      </div>
      <table>
        <thead><tr><th>Code</th><th>Value</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>
          {shown.slice(0, 100).map((v) => (
            <tr key={v.id}>
              <td><code>{v.code}</code></td>
              <td>{money(v.value_cents)}</td>
              <td><span className={`badge ${v.status}`}>{v.status}</span></td>
              <td style={{ color: 'var(--muted)' }}>{new Date(v.created_at).toLocaleString()}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No vouchers{statusFilter === 'all' ? ' yet' : ` with status “${statusFilter}”`}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
