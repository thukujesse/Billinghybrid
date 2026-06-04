'use client';
import { useEffect, useState } from 'react';

// Customer self-serve portal at /portal. SMS-OTP login, view services /
// usage / expiry, top up via M-Pesa STK push. Bare-bones styling — meant
// for customers on phones, not for the admin dashboard.
//
// The legacy subscriber portal (wallet, KYC, gift plans, voucher redeem)
// lives at /portal/legacy.

const TOKEN_KEY = 'jtm_portal_token';
const GB = 1024 ** 3;
const MB = 1024 ** 2;

interface Service {
  id: string;
  service_type: string;
  username: string | null;
  plan_id: string | null;
  plan_name: string | null;
  plan_price_cents: number | null;
  rate_limit: string | null;
  status: 'active' | 'suspended' | 'expired' | 'cancelled';
  expiry_date: string | null;
  seconds_remaining: number | null;
  auto_renew: boolean;
  current_session: {
    started_at: string;
    framed_ip: string | null;
    bytes_in: number;
    bytes_out: number;
  } | null;
  period_bytes_total: number;
}

interface PortalMe {
  customer: {
    id: string;
    account_number: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    status: 'active' | 'suspended' | 'closed';
    notification_channels: Array<'sms' | 'email' | 'whatsapp'>;
  };
  wallet: {
    balance_cents: number;
    updated_at: string;
  };
  services: Service[];
  recent_payments: Array<{
    id: string;
    amount_kes: number;
    plan_name: string | null;
    status: string;
    created_at: string;
  }>;
}

interface WalletTxn {
  id: string;
  kind: 'topup' | 'renewal_debit' | 'adjustment' | 'refund';
  amount_cents: number;
  balance_after_cents: number;
  reference: string | null;
  notes: string | null;
  actor: string;
  created_at: string;
}

interface Plan {
  id: string;
  name: string;
  price_cents: number;
  validity_days: number;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
}

// Bypass the /admin auth header that lib/api.ts attaches. We use a
// customer-scoped JWT under our own storage key — auto-included below.
async function portalApi<T = any>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> {
  const base = (() => {
    if (typeof window === 'undefined') return '';
    if (window.location.hostname.startsWith('billing.') || window.location.hostname.startsWith('portal.')) {
      return window.location.origin;
    }
    return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  })();
  const t = token ?? (typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null);
  const res = await fetch(`${base}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(options.headers ?? {}),
    },
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `Request failed (${res.status})`);
  return data as T;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return '254' + digits;
  return null;
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / GB).toFixed(2)} GB`;
}

function formatRemaining(secs: number | null): { label: string; color: string } {
  if (secs === null || secs === undefined) return { label: '—', color: '#64748b' };
  if (secs <= 0) return { label: 'Expired', color: '#b91c1c' };
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  let label = '';
  if (d > 0) label = h ? `${d}d ${h}h` : `${d}d`;
  else if (h > 0) label = m ? `${h}h ${m}m` : `${h}h`;
  else label = `${Math.max(1, m)}m`;
  const color = secs < 3600 ? '#b91c1c' : secs < 86400 ? '#d97706' : '#15803d';
  return { label, color };
}

export default function CustomerPortal() {
  const [phase, setPhase] = useState<'login_phone' | 'login_code' | 'home' | 'renew' | 'paying' | 'topup' | 'txns'>('login_phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [me, setMe] = useState<PortalMe | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [renew, setRenew] = useState<{ service: Service; planId: string; phone: string } | null>(null);
  const [pollState, setPollState] = useState<{ checkoutRequestId: string; status: string; failureReason?: string; elapsedSec: number } | null>(null);
  // Wallet top-up state: customer picks amount, we STK-push for that exact
  // amount, then reuse the existing polling flow with a "topup" intent.
  const [topup, setTopup] = useState<{ amount: number; phone: string }>({ amount: 500, phone: '' });
  const [txns, setTxns] = useState<WalletTxn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Pull the active session on mount if we already have a token. Self-heals
  // by clearing the token on 401 — expired sessions drop the customer back
  // to the login screen without a confusing error message.
  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) return;
    portalApi<PortalMe>('/portal/me', {}, t)
      .then((m) => { setMe(m); setPhase('home'); loadPlans(); })
      .catch(() => { localStorage.removeItem(TOKEN_KEY); });
  }, []);

  const loadPlans = () => {
    portalApi<Plan[]>('/plans').then((all) => setPlans(all.filter((p) => p.price_cents > 0))).catch(() => {});
  };

  const requestOtp = async () => {
    const norm = normalizePhone(phone);
    if (!norm) { setError('Enter a valid Safaricom number (07XX or 2547XX).'); return; }
    setBusy(true); setError(null);
    try {
      const r = await portalApi<{ sent: boolean; devCode?: string }>('/portal/auth/request', {
        method: 'POST', body: JSON.stringify({ phone: norm }),
      });
      setPhase('login_code');
      setInfo(r.devCode
        ? `Dev mode — code is ${r.devCode}`
        : `Code sent to ${norm.replace(/(\d{3})(\d{3})(\d{3})(\d{3})/, '$1 *** *** $4')}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    const norm = normalizePhone(phone);
    if (!norm) return;
    setBusy(true); setError(null);
    try {
      const r = await portalApi<{ token: string; customerId: string }>('/portal/auth/verify', {
        method: 'POST', body: JSON.stringify({ phone: norm, code }),
      });
      localStorage.setItem(TOKEN_KEY, r.token);
      const m = await portalApi<PortalMe>('/portal/me', {}, r.token);
      setMe(m);
      setPhase('home');
      loadPlans();
      setCode(''); setInfo(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const togglePortalChannel = async (channel: 'sms' | 'email' | 'whatsapp') => {
    if (!me) return;
    const current = me.customer.notification_channels ?? ['sms'];
    const next = current.includes(channel)
      ? current.filter((c) => c !== channel)
      : [...current, channel];
    setBusy(true);
    try {
      await portalApi('/portal/notification-channels', {
        method: 'PUT',
        body: JSON.stringify({ channels: next }),
      });
      const m = await portalApi<PortalMe>('/portal/me');
      setMe(m);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setMe(null);
    setPhone(''); setCode('');
    setPhase('login_phone');
  };

  const openRenew = (service: Service) => {
    setRenew({
      service,
      planId: service.plan_id ?? (plans[0]?.id ?? ''),
      phone: me?.customer.phone ?? phone,
    });
    setPhase('renew');
  };

  const openTopup = () => {
    setTopup({ amount: 500, phone: me?.customer.phone ?? phone });
    setError(null); setInfo(null);
    setPhase('topup');
  };

  const submitTopup = async () => {
    if (!me) return;
    const norm = normalizePhone(topup.phone);
    if (!norm) { setError('Enter a valid M-Pesa number.'); return; }
    if (topup.amount < 10) { setError('Minimum top-up is KES 10.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await portalApi<{ checkoutRequestId: string; customerMessage: string; simulated: boolean }>(
        '/portal/wallet/topup', {
          method: 'POST',
          body: JSON.stringify({ amount_kes: topup.amount, phone: norm }),
        }
      );
      setPollState({ checkoutRequestId: r.checkoutRequestId, status: 'pending', elapsedSec: 0 });
      setPhase('paying');
      pollPayment(r.checkoutRequestId, r.simulated);
      setInfo(r.simulated ? 'Simulation — auto-confirming.' : 'STK push sent. Approve on your phone.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Renew straight from wallet — no STK push, no waiting. Server debits +
  // extends expiry in one transaction; we just refresh /me and the new
  // expiry shows up on the home screen.
  const renewFromWallet = async (service: Service) => {
    if (!confirm(`Use wallet to renew ${service.plan_name}? You'll be charged KES ${((service.plan_price_cents ?? 0) / 100).toFixed(0)}.`)) return;
    setBusy(true); setError(null);
    try {
      await portalApi('/portal/wallet/renew', {
        method: 'POST',
        body: JSON.stringify({ service_id: service.id }),
      });
      const m = await portalApi<PortalMe>('/portal/me');
      setMe(m);
      setInfo(`Renewed from wallet — new expiry ${new Date(m.services.find((s) => s.id === service.id)?.expiry_date ?? '').toLocaleString()}`);
    } catch (e: any) {
      // Surface insufficient-balance with a helpful next-action prompt.
      setError(e.message.includes('insufficient')
        ? 'Wallet balance too low. Top up first.'
        : e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoRenew = async (service: Service) => {
    setBusy(true); setError(null);
    try {
      await portalApi(`/portal/services/${service.id}/auto-renew`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !service.auto_renew }),
      });
      const m = await portalApi<PortalMe>('/portal/me');
      setMe(m);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openTxns = async () => {
    setBusy(true); setError(null);
    try {
      const t = await portalApi<WalletTxn[]>('/portal/wallet/txns?limit=100');
      setTxns(t);
      setPhase('txns');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitRenew = async () => {
    if (!renew) return;
    const norm = normalizePhone(renew.phone);
    if (!norm) { setError('Enter a valid M-Pesa number.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await portalApi<{ checkoutRequestId: string; customerMessage: string; simulated: boolean }>('/portal/renew', {
        method: 'POST',
        body: JSON.stringify({
          service_id: renew.service.id,
          plan_id: renew.planId,
          phone: norm,
        }),
      });
      setPollState({ checkoutRequestId: r.checkoutRequestId, status: 'pending', elapsedSec: 0 });
      setPhase('paying');
      pollPayment(r.checkoutRequestId, r.simulated);
      setInfo(r.simulated ? 'Simulation mode — auto-confirming.' : 'STK push sent. Approve on your phone.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pollPayment = async (id: string, simulated: boolean) => {
    if (simulated) {
      try { await portalApi(`/hotspot/pay/${id}/confirm-test`, { method: 'POST' }); } catch {}
    }
    const start = Date.now();
    const deadline = start + 120_000;
    const tick = async () => {
      try {
        const s = await portalApi<{ status: string; failureReason?: string }>(`/portal/pay/${id}`);
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        setPollState({ checkoutRequestId: id, status: s.status, failureReason: s.failureReason, elapsedSec });
        if (s.status === 'success') {
          setInfo('Payment received. Your service has been restored.');
          // Reload the home state so the new expiry shows up.
          const m = await portalApi<PortalMe>('/portal/me');
          setMe(m);
          setTimeout(() => { setPhase('home'); setRenew(null); setPollState(null); }, 2000);
          return;
        }
        if (s.status === 'failed' || s.status === 'expired') {
          setError(`Payment ${s.status}: ${s.failureReason ?? 'unknown'}`);
          return;
        }
        if (Date.now() > deadline) {
          setError('Timed out waiting for M-Pesa.');
          return;
        }
        setTimeout(tick, 2500);
      } catch (e: any) {
        setError(e.message);
      }
    };
    setTimeout(tick, 2500);
  };

  const card: React.CSSProperties = {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
    padding: 20, marginBottom: 16,
  };
  const btn: React.CSSProperties = {
    width: '100%', padding: 12, fontSize: 14, fontWeight: 600,
    background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer',
  };
  const btnGhost: React.CSSProperties = {
    ...btn, background: 'transparent', color: '#475569', border: '1px solid #e2e8f0',
  };
  const input: React.CSSProperties = {
    width: '100%', padding: '12px 14px', fontSize: 14,
    border: '1px solid #e2e8f0', borderRadius: 8, marginTop: 4,
  };
  const label: React.CSSProperties = { fontSize: 12, color: '#475569', fontWeight: 500 };
  const sub: React.CSSProperties = { fontSize: 12, color: '#64748b', margin: 0 };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, rgba(37,99,235,0.04) 0%, #f8fafc 100%)',
      padding: 16,
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ maxWidth: 480, margin: '0 auto', paddingTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 22, color: '#0f172a' }}>HUB Networks</h1>
          {me && (
            <button onClick={logout} style={{ ...btnGhost, width: 'auto', padding: '6px 10px', fontSize: 11 }}>
              Log out
            </button>
          )}
        </div>

        {error && <div style={{ ...card, background: 'rgba(220,38,38,0.08)', color: '#b91c1c', fontSize: 13 }}>{error}</div>}
        {info && !error && <div style={{ ...card, background: 'rgba(22,163,74,0.10)', color: '#15803d', fontSize: 13 }}>{info}</div>}

        {phase === 'login_phone' && (
          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Sign in</h2>
            <p style={sub}>Enter your phone number — we'll text you a 6-digit code.</p>
            <label style={label}>Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX XXX XXX" inputMode="tel" style={input} />
            <button onClick={requestOtp} disabled={busy} style={{ ...btn, marginTop: 16, opacity: busy ? 0.5 : 1 }}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
        )}

        {phase === 'login_code' && (
          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Enter code</h2>
            <p style={sub}>6-digit code sent to your phone.</p>
            <input
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              style={{ ...input, fontSize: 22, textAlign: 'center', letterSpacing: 6 }}
            />
            <button onClick={verifyOtp} disabled={busy || code.length < 6} style={{ ...btn, marginTop: 16, opacity: busy || code.length < 6 ? 0.5 : 1 }}>
              {busy ? 'Verifying…' : 'Verify & sign in'}
            </button>
            <button onClick={() => { setPhase('login_phone'); setCode(''); setError(null); setInfo(null); }}
              style={{ ...btnGhost, marginTop: 8 }}>
              Use a different phone
            </button>
          </div>
        )}

        {phase === 'home' && me && (
          <>
            <div style={card}>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>{me.customer.full_name}</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                Account <code>{me.customer.account_number}</code>
                {me.customer.phone && <> · {me.customer.phone}</>}
              </div>
            </div>

            {/* Wallet balance — large + accent so customers see the headline
                number first; top-up button beneath, history link to the right. */}
            <div style={{ ...card, background: 'linear-gradient(135deg, rgba(37,99,235,0.06) 0%, #fff 100%)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Wallet</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#2563eb', marginTop: 4 }}>
                    KES {(me.wallet.balance_cents / 100).toFixed(0)}
                  </div>
                </div>
                <button onClick={openTxns} style={{ ...btnGhost, width: 'auto', padding: '6px 10px', fontSize: 11 }}>
                  History
                </button>
              </div>
              <button onClick={openTopup} style={{ ...btn, marginTop: 12 }}>Top up via M-Pesa</button>
              <p style={{ ...sub, fontSize: 11, marginTop: 8 }}>
                Auto-renew enabled services will be paid from this balance when they expire.
              </p>
            </div>

            {/* Notification channel preferences — tap a chip to opt in/out.
                Renewal confirmations, top-up receipts, and expiry warnings
                fan out to every selected channel. */}
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>How we contact you</div>
                {(me.customer.notification_channels ?? []).length === 0 && (
                  <span style={{ fontSize: 11, color: '#b91c1c' }}>Opted out — won't receive messages</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['sms', 'email', 'whatsapp'] as const).map((ch) => {
                  const on = (me.customer.notification_channels ?? []).includes(ch);
                  const disabled = busy ||
                    (ch === 'email'    && !me.customer.email) ||
                    ((ch === 'sms' || ch === 'whatsapp') && !me.customer.phone);
                  return (
                    <button key={ch} onClick={() => togglePortalChannel(ch)} disabled={disabled}
                      style={{
                        ...btn,
                        flex: '0 0 auto',
                        background: on ? '#15803d' : 'transparent',
                        color: on ? '#fff' : '#475569',
                        border: on ? 'none' : '1px solid #e2e8f0',
                        padding: '8px 14px',
                        fontSize: 12,
                        opacity: disabled ? 0.4 : 1,
                        textTransform: 'uppercase',
                      }}>
                      {ch}
                    </button>
                  );
                })}
              </div>
              <p style={{ ...sub, fontSize: 11, marginTop: 8 }}>
                Email needs a saved address; SMS &amp; WhatsApp use your phone.
              </p>
            </div>

            {me.services.length === 0 ? (
              <div style={card}>
                <p style={sub}>No services on file yet. Contact support to set up your internet.</p>
              </div>
            ) : me.services.map((s) => {
              const rem = formatRemaining(s.seconds_remaining);
              return (
                <div key={s.id} style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
                        {s.plan_name ?? s.service_type}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {s.username && <code>{s.username}</code>}
                        {s.rate_limit && <> · {s.rate_limit}</>}
                      </div>
                    </div>
                    <span style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                      background: s.status === 'active' ? 'rgba(22,163,74,0.12)' :
                                  s.status === 'expired' ? 'rgba(220,38,38,0.12)' : 'rgba(217,119,6,0.12)',
                      color: s.status === 'active' ? '#15803d' :
                             s.status === 'expired' ? '#b91c1c' : '#a16207',
                    }}>{s.status}</span>
                  </div>

                  <div style={{ marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: '#64748b' }}>Time left</span>
                      <strong style={{ color: rem.color }}>{rem.label}</strong>
                    </div>
                    {s.expiry_date && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                        <span>Expires</span>
                        <span>{new Date(s.expiry_date).toLocaleString()}</span>
                      </div>
                    )}
                  </div>

                  {(s.current_session || s.period_bytes_total > 0) && (
                    <div style={{ marginTop: 8, padding: 12, background: '#f8fafc', borderRadius: 8, fontSize: 12 }}>
                      {s.current_session && (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#64748b' }}>● Online now</span>
                            <span style={{ color: '#15803d', fontWeight: 600 }}>
                              {formatBytes(s.current_session.bytes_in + s.current_session.bytes_out)} this session
                            </span>
                          </div>
                          {s.current_session.framed_ip && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                              <span>IP</span><code>{s.current_session.framed_ip}</code>
                            </div>
                          )}
                        </>
                      )}
                      {s.period_bytes_total > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                          <span>Total this cycle</span>
                          <span>{formatBytes(s.period_bytes_total)}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Wallet-driven renew — only when we know the plan price
                      AND the wallet covers it. The pure M-Pesa fallback is
                      always available below. */}
                  {s.plan_price_cents && me.wallet.balance_cents >= s.plan_price_cents ? (
                    <button onClick={() => renewFromWallet(s)}
                      disabled={busy}
                      style={{ ...btn, marginTop: 12, background: '#15803d' }}>
                      Renew from wallet · KES {(s.plan_price_cents / 100).toFixed(0)}
                    </button>
                  ) : null}
                  <button onClick={() => openRenew(s)} style={{
                    ...(s.plan_price_cents && me.wallet.balance_cents >= s.plan_price_cents ? btnGhost : btn),
                    marginTop: 8,
                  }}>
                    Renew via M-Pesa
                  </button>

                  {/* Per-service auto-renew toggle. When ON, the worker
                      debits the wallet 24h before expiry and silently
                      extends the service. */}
                  <div style={{ marginTop: 10, padding: 10, background: '#f8fafc', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12 }}>
                      <div style={{ fontWeight: 600 }}>Auto-renew</div>
                      <div style={{ color: '#64748b', fontSize: 11 }}>
                        {s.auto_renew ? 'On — paid from wallet on expiry' : 'Off — you renew manually'}
                      </div>
                    </div>
                    <button onClick={() => toggleAutoRenew(s)} disabled={busy}
                      style={{
                        background: s.auto_renew ? '#15803d' : '#cbd5e1',
                        color: '#fff', border: 'none', borderRadius: 12,
                        padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      }}>
                      {s.auto_renew ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>
              );
            })}

            {me.recent_payments.length > 0 && (
              <div style={card}>
                <h3 style={{ marginTop: 0, fontSize: 14 }}>Recent payments</h3>
                {me.recent_payments.map((p) => (
                  <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                    <div>
                      <div>{p.plan_name ?? 'Payment'}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{new Date(p.created_at).toLocaleString()}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 600 }}>KES {p.amount_kes}</div>
                      <div style={{ fontSize: 10, color: p.status === 'success' ? '#15803d' : p.status === 'pending' ? '#a16207' : '#b91c1c' }}>{p.status}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {phase === 'renew' && renew && (
          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Renew {renew.service.username}</h2>
            <label style={label}>Plan</label>
            <select value={renew.planId} onChange={(e) => setRenew({ ...renew, planId: e.target.value })} style={input}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · KES {(p.price_cents / 100).toFixed(0)} · {p.validity_days}d
                </option>
              ))}
            </select>
            <label style={{ ...label, marginTop: 12, display: 'block' }}>M-Pesa phone</label>
            <input value={renew.phone} onChange={(e) => setRenew({ ...renew, phone: e.target.value })} inputMode="tel" style={input} />
            <button onClick={submitRenew} disabled={busy || !renew.planId} style={{ ...btn, marginTop: 16, opacity: busy || !renew.planId ? 0.5 : 1 }}>
              {busy ? 'Sending…' : 'Pay & restore'}
            </button>
            <button onClick={() => { setPhase('home'); setRenew(null); setError(null); }} style={{ ...btnGhost, marginTop: 8 }}>
              Cancel
            </button>
          </div>
        )}

        {phase === 'paying' && pollState && (
          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Waiting for M-Pesa</h2>
            <p style={sub}>Approve the STK prompt on your phone. This page will refresh when payment lands.</p>
            <div style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: '#64748b' }}>
              <strong style={{ fontSize: 28, color: '#2563eb' }}>{pollState.elapsedSec}s</strong>
              <div style={{ marginTop: 8 }}>Status: <strong>{pollState.status}</strong></div>
            </div>
            <button onClick={() => { setPhase('home'); setRenew(null); setPollState(null); setError(null); }}
              style={{ ...btnGhost, marginTop: 16 }}>
              I'll check later
            </button>
          </div>
        )}

        {phase === 'topup' && me && (
          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Top up wallet</h2>
            <p style={sub}>Current balance: <strong>KES {(me.wallet.balance_cents / 100).toFixed(0)}</strong></p>

            <label style={{ ...label, marginTop: 12, display: 'block' }}>Amount (KES)</label>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {[200, 500, 1000, 2000, 5000].map((amt) => (
                <button key={amt} onClick={() => setTopup({ ...topup, amount: amt })}
                  style={{
                    ...btnGhost, padding: '8px 10px', fontSize: 12,
                    background: topup.amount === amt ? 'rgba(37,99,235,0.12)' : 'transparent',
                    color: topup.amount === amt ? '#2563eb' : '#475569',
                    borderColor: topup.amount === amt ? '#2563eb' : '#e2e8f0',
                  }}>
                  {amt}
                </button>
              ))}
            </div>
            <input value={String(topup.amount)} type="number" min={10} max={70000}
              onChange={(e) => setTopup({ ...topup, amount: Number(e.target.value) || 0 })}
              style={{ ...input, marginTop: 8, fontSize: 18, textAlign: 'center', fontWeight: 600 }} />

            <label style={{ ...label, marginTop: 12, display: 'block' }}>M-Pesa phone</label>
            <input value={topup.phone} onChange={(e) => setTopup({ ...topup, phone: e.target.value })}
              inputMode="tel" placeholder="07XX XXX XXX" style={input} />

            <button onClick={submitTopup} disabled={busy || topup.amount < 10}
              style={{ ...btn, marginTop: 16, opacity: busy || topup.amount < 10 ? 0.5 : 1 }}>
              {busy ? 'Sending…' : `Pay KES ${topup.amount} via M-Pesa`}
            </button>
            <button onClick={() => { setPhase('home'); setError(null); }} style={{ ...btnGhost, marginTop: 8 }}>
              Cancel
            </button>
          </div>
        )}

        {phase === 'txns' && me && (
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Wallet history</h2>
              <button onClick={() => setPhase('home')} style={{ ...btnGhost, width: 'auto', padding: '6px 10px', fontSize: 11 }}>
                Back
              </button>
            </div>
            <div style={{ marginBottom: 12, padding: 10, background: '#f8fafc', borderRadius: 6, fontSize: 13 }}>
              Current balance: <strong style={{ color: '#2563eb' }}>KES {(me.wallet.balance_cents / 100).toFixed(0)}</strong>
            </div>
            {txns.length === 0 ? (
              <p style={sub}>No wallet activity yet.</p>
            ) : txns.map((t) => {
              const amt = t.amount_cents / 100;
              const isCredit = amt > 0;
              return (
                <div key={t.id} style={{
                  display: 'flex', justifyContent: 'space-between', padding: '10px 0',
                  borderBottom: '1px solid #f1f5f9', fontSize: 13,
                }}>
                  <div>
                    <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{t.kind.replace('_', ' ')}</div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>
                      {new Date(t.created_at).toLocaleString()} · by {t.actor}
                      {t.reference && <> · {t.reference}</>}
                    </div>
                    {t.notes && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{t.notes}</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, color: isCredit ? '#15803d' : '#b91c1c' }}>
                      {isCredit ? '+' : ''}KES {amt.toFixed(0)}
                    </div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>
                      bal {(t.balance_after_cents / 100).toFixed(0)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
