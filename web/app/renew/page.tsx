'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface RenewInfo {
  customer: { full_name: string; account_number: string; phone: string | null } | null;
  service: { id: string; username: string | null; service_type: string } | null;
  plans: { id: string; name: string; price_cents: number; validity_days: number }[];
  reason: string;
}

interface RenewPayResult {
  checkoutRequestId: string;
  amountKes: number;
  customerMessage: string;
  simulated: boolean;
}

export default function RenewPage() {
  const [info, setInfo] = useState<RenewInfo | null>(null);
  const [phone, setPhone] = useState('');
  const [planId, setPlanId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [lookingUp, setLookingUp] = useState(false);

  const lookupCustomer = (params: Record<string, string>) => {
    setLookingUp(true);
    return api<RenewInfo>(`/renew/info?${new URLSearchParams(params)}`)
      .then((r) => {
        setInfo(r);
        if (r.customer?.phone) setPhone(r.customer.phone);
        if (r.plans[0]) setPlanId(r.plans[0].id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLookingUp(false));
  };

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const params: Record<string, string> = {};
    for (const k of ['customer', 'ip', 'mac', 'username']) {
      const v = q.get(k);
      if (v) params[k] = v;
    }
    // Only auto-lookup if URL has one of these. Otherwise wait for user input.
    if (Object.keys(params).length > 0) {
      lookupCustomer(params);
    }
  }, []);

  const lookupByUsername = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!usernameInput.trim()) return;
    setError(null);
    lookupCustomer({ username: usernameInput.trim() });
  };

  const pay = async () => {
    if (!planId || !phone) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<RenewPayResult>('/renew/pay', {
        method: 'POST',
        body: JSON.stringify({
          plan_id: planId,
          phone,
          service_id: info?.service?.id,
          username: info?.service?.username,
        }),
      });
      setStatus(
        r.simulated
          ? 'Simulation mode — confirming…'
          : 'STK push sent — check your phone for the M-Pesa prompt.'
      );
      pollStatus(r.checkoutRequestId, r.simulated);
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  };

  const pollStatus = async (id: string, simulated: boolean) => {
    if (simulated) {
      try {
        await api(`/hotspot/pay/${id}/confirm-test`, { method: 'POST' });
      } catch {/* fall through to polling */}
    }
    const deadline = Date.now() + 120_000;
    const tick = async () => {
      try {
        const s = await api<{ status: string; failureReason?: string }>(`/hotspot/pay/${id}`);
        if (s.status === 'success') {
          setStatus('✓ Payment received. Your service is being restored — try browsing again in 10 seconds.');
          setSuccess(true);
          setSubmitting(false);
          return;
        }
        if (s.status === 'failed' || s.status === 'expired') {
          setError(`Payment ${s.status}: ${s.failureReason ?? 'unknown'}`);
          setSubmitting(false);
          return;
        }
        if (Date.now() > deadline) {
          setError('Timed out waiting for M-Pesa.');
          setSubmitting(false);
          return;
        }
        setTimeout(tick, 2500);
      } catch (e: any) {
        setError(e.message);
        setSubmitting(false);
      }
    };
    setTimeout(tick, 2500);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ maxWidth: 480, width: '100%' }}>
        <h1 style={{ marginBottom: 8 }}>HUB Networks — Renew</h1>
        <p className="sub" style={{ marginBottom: 20 }}>
          Your subscription has expired. Pick a plan and pay via M-Pesa to restore service.
        </p>

        {info?.customer && (
          <div className="toast" style={{ marginBottom: 16, background: 'var(--surface)' }}>
            <strong>{info.customer.full_name}</strong>
            <br /><small className="sub">{info.customer.account_number}</small>
          </div>
        )}
        {!info && !error && !lookingUp && (
          <form onSubmit={lookupByUsername} style={{ marginBottom: 16 }}>
            <label>PPPoE Username</label>
            <input
              autoFocus
              value={usernameInput}
              placeholder="e.g. jwanjiku"
              onChange={(e) => setUsernameInput(e.target.value)}
            />
            <button type="submit" style={{ width: '100%', marginTop: 8 }}>
              Find my account
            </button>
          </form>
        )}
        {lookingUp && <p className="sub">Looking up your account…</p>}
        {info && !info.customer && (
          <div className="toast err" style={{ marginBottom: 16 }}>
            {info.reason || "We couldn't find that username."}
            <br />
            <button
              onClick={() => { setInfo(null); setUsernameInput(''); }}
              className="ghost"
              style={{ marginTop: 8, fontSize: 12 }}
            >
              Try again
            </button>
          </div>
        )}

        {success ? (
          <div className="toast ok">{status}</div>
        ) : (
          <>
            {info?.plans && info.plans.length > 0 ? (
              <>
                <label>Plan</label>
                <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  {info.plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — KES {(p.price_cents / 100).toFixed(0)} · {p.validity_days}d
                    </option>
                  ))}
                </select>
                <label style={{ marginTop: 12 }}>M-Pesa phone</label>
                <input
                  value={phone}
                  placeholder="07XX or 2547XX..."
                  onChange={(e) => setPhone(e.target.value)}
                  inputMode="tel"
                />
                <button
                  onClick={pay}
                  disabled={!planId || !phone || submitting}
                  style={{ width: '100%', marginTop: 16, padding: '12px' }}
                >
                  {submitting ? 'Processing…' : 'Pay & Restore'}
                </button>
              </>
            ) : info ? (
              <p className="sub">No renewal plans available. Contact support.</p>
            ) : null}

            {status && !error && <div className="toast ok" style={{ marginTop: 12 }}>{status}</div>}
            {error && <div className="toast err" style={{ marginTop: 12 }}>{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
