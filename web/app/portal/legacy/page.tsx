'use client';
import { useState } from 'react';
import { api, money } from '@/lib/api';
import { useLang, tr } from '@/lib/i18n';

const GB = 1024 * 1024 * 1024;

export default function Portal() {
  const [lang, setLang] = useLang();
  const [phone, setPhone] = useState('');
  const [sub, setSub] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [code, setCode] = useState('');
  const [buyPlanId, setBuyPlanId] = useState('');
  const [giftPhone, setGiftPhone] = useState('');
  const [changePlanId, setChangePlanId] = useState('');
  const [kycType, setKycType] = useState('id_card');
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const refresh = async (id: string) => {
    const [full, w, u] = await Promise.all([
      api(`/subscribers/${id}`),
      api(`/subscribers/${id}/wallet`),
      api(`/subscribers/${id}/usage`),
    ]);
    setSub(full); setWallet(w); setUsage(u);
    setPlans(await api('/plans'));
  };

  // Switch UI language; if an account is loaded, persist it so notifications
  // (SMS/WhatsApp) come in the same language.
  const changeLang = async (l: 'en' | 'sw') => {
    setLang(l);
    if (sub?.id) {
      try { await api(`/subscribers/${sub.id}/language`, { method: 'POST', body: JSON.stringify({ language: l }) }); } catch {}
    }
  };

  const lookup = async () => {
    setToast(null);
    try {
      const matches = await api(`/subscribers?phone=${encodeURIComponent(phone)}`);
      if (!matches.length) { setToast({ ok: false, msg: 'No account for that number' }); setSub(null); return; }
      await refresh(matches[0].id);
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const redeem = async () => {
    try {
      await api('/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code, subscriber_id: sub.id }) });
      setToast({ ok: true, msg: 'Voucher redeemed — you are connected!' });
      setCode('');
      refresh(sub.id);
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const buy = async () => {
    try {
      const body: any = { plan_id: buyPlanId };
      if (giftPhone.trim()) {
        const matches = await api(`/subscribers?phone=${encodeURIComponent(giftPhone.trim())}`);
        if (!matches.length) { setToast({ ok: false, msg: 'No account for that gift number' }); return; }
        body.recipient_id = matches[0].id;
      }
      const r = await api(`/subscribers/${sub.id}/buy-plan`, { method: 'POST', body: JSON.stringify(body) });
      if (r.paid) {
        setToast({ ok: true, msg: r.gifted ? 'Gift plan delivered!' : 'Plan purchased and activated!' });
        setBuyPlanId(''); setGiftPhone('');
        refresh(sub.id);
      } else {
        setToast({ ok: false, msg: r.reason === 'insufficient_balance' ? 'Insufficient balance — top up first' : 'Payment failed' });
      }
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const change = async () => {
    try {
      const r = await api(`/subscribers/${sub.id}/change-plan`, { method: 'POST', body: JSON.stringify({ plan_id: changePlanId }) });
      if (r.paid) {
        const net = r.net_cents;
        const msg = net > 0 ? `${r.direction}: charged ${money(net)} (prorated)` : net < 0 ? `${r.direction}: credited ${money(-net)} to wallet` : 'plan changed';
        setToast({ ok: true, msg });
        setChangePlanId('');
        refresh(sub.id);
      } else {
        setToast({ ok: false, msg: r.reason === 'insufficient_balance' ? 'Insufficient balance for the upgrade — top up first' : 'Change failed' });
      }
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const uploadKyc = async (file: File) => {
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1] ?? '';
      await api(`/subscribers/${sub.id}/kyc`, {
        method: 'POST',
        body: JSON.stringify({ doc_type: kycType, filename: file.name, content_base64: base64, content_type: file.type }),
      });
      setToast({ ok: true, msg: 'Document uploaded — pending review' });
      refresh(sub.id);
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const topup = async () => {
    const amt = prompt('Top-up via M-Pesa (KES):', '500');
    if (!amt) return;
    try {
      const { checkoutRequestId } = await api('/payments/mpesa/stk', { method: 'POST', body: JSON.stringify({ subscriber_id: sub.id, amount_cents: Math.round(Number(amt) * 100) }) });
      await api('/payments/mpesa/callback', { method: 'POST', body: JSON.stringify({ checkout_request_id: checkoutRequestId, outcome: 'success' }) });
      setToast({ ok: true, msg: 'Top-up confirmed' });
      refresh(sub.id);
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>{tr(lang, 'portal_title')}</h1>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className={lang === 'en' ? '' : 'ghost'} onClick={() => changeLang('en')}>EN</button>
          <button className={lang === 'sw' ? '' : 'ghost'} onClick={() => changeLang('sw')}>SW</button>
        </div>
      </div>
      <p className="sub">{tr(lang, 'portal_sub')}</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <div className="row">
          <div><label>{tr(lang, 'phone_label')}</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="2547..." /></div>
          <div style={{ flex: '0 0 auto' }}><button onClick={lookup} disabled={!phone}>{tr(lang, 'lookup')}</button></div>
        </div>
      </div>

      {sub && (
        <>
          <div className="grid" style={{ marginTop: 16 }}>
            <div className="card stat"><div className="label">{tr(lang, 'account')}</div><div className="value" style={{ fontSize: 18 }}>{sub.full_name}</div><div className="sub" style={{ margin: 0 }}>{sub.type} · <span className={`badge ${sub.status}`}>{sub.status}</span></div></div>
            <div className="card stat"><div className="label">{tr(lang, 'wallet_balance')}</div><div className="value">{money(wallet?.balance_cents ?? 0)}</div><button className="ghost" style={{ marginTop: 10 }} onClick={topup}>{tr(lang, 'mpesa_topup')}</button></div>
            <div className="card stat"><div className="label">{tr(lang, 'data_used')}</div><div className="value">{(((Number(usage?.bytes_in ?? 0) + Number(usage?.bytes_out ?? 0))) / GB).toFixed(2)} GB</div></div>
          </div>

          <h2>{tr(lang, 'kyc_title')} — <span className={`badge ${sub.kyc_status === 'verified' ? 'active' : sub.kyc_status === 'rejected' ? 'suspended' : 'pending'}`}>{sub.kyc_status}</span></h2>
          <div className="card">
            <div className="row">
              <div><label>Document type</label>
                <select value={kycType} onChange={(e) => setKycType(e.target.value)}>
                  <option value="id_card">National ID</option>
                  <option value="passport">Passport</option>
                  <option value="selfie">Selfie</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div><label>File</label><input type="file" onChange={(e) => e.target.files?.[0] && uploadKyc(e.target.files[0])} /></div>
            </div>
          </div>

          <h2>{tr(lang, 'active_subs')}</h2>
          <table>
            <thead><tr><th>Plan</th><th>Status</th><th>Expires</th></tr></thead>
            <tbody>
              {(sub.subscriptions ?? []).map((s: any) => {
                const plan = plans.find((p) => p.id === s.plan_id);
                return (
                  <tr key={s.id}>
                    <td>{plan?.name ?? s.plan_id.slice(0, 8)}</td>
                    <td><span className={`badge ${s.status}`}>{s.status}</span></td>
                    <td style={{ color: 'var(--muted)' }}>{s.end_at ? new Date(s.end_at).toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
              {(!sub.subscriptions || sub.subscriptions.length === 0) && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>No active plan</td></tr>}
            </tbody>
          </table>

          {(sub.subscriptions ?? []).some((s: any) => s.status === 'active') && (
            <>
              <h2>{tr(lang, 'change_plan')}</h2>
              <div className="card">
                <div className="row">
                  <div><label>Switch to</label>
                    <select value={changePlanId} onChange={(e) => setChangePlanId(e.target.value)}>
                      <option value="">Select plan…</option>
                      {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price_cents)}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: '0 0 auto' }}><button onClick={change} disabled={!changePlanId}>Change plan</button></div>
                </div>
                <p className="sub" style={{ margin: '10px 0 0' }}>Upgrades charge the prorated difference; downgrades credit your wallet.</p>
              </div>
            </>
          )}

          <h2>{tr(lang, 'buy_plan')}</h2>
          <div className="card">
            <div className="row">
              <div><label>Plan</label>
                <select value={buyPlanId} onChange={(e) => setBuyPlanId(e.target.value)}>
                  <option value="">Select plan…</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price_cents)}</option>)}
                </select>
              </div>
              <div><label>Gift to phone (optional)</label><input value={giftPhone} onChange={(e) => setGiftPhone(e.target.value)} placeholder="leave blank to buy for yourself" /></div>
              <div style={{ flex: '0 0 auto' }}><button onClick={buy} disabled={!buyPlanId}>Pay from wallet</button></div>
            </div>
            <p className="sub" style={{ margin: '10px 0 0' }}>Paid from your wallet balance (price + VAT). Top up via M-Pesa above if needed.</p>
          </div>

          <h2>{tr(lang, 'redeem_voucher')}</h2>
          <div className="card">
            <div className="row">
              <div><label>Voucher code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-2345-WXYZ" /></div>
              <div style={{ flex: '0 0 auto' }}><button onClick={redeem} disabled={!code}>Redeem</button></div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
