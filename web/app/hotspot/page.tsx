'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface GrantResult {
  username: string;
  password: string;
  validitySeconds: number;
  rateLimit: string | null;
  planName: string;
}

interface HotspotPlan {
  id: string;
  name: string;
  price_cents: number;
  validity_days: number;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
}

interface PurchaseInit {
  checkoutRequestId: string;
  amountKes: number;
  customerMessage: string;
  simulated: boolean;
}

type Tab = 'voucher' | 'pay';

const PHONE_KEY = 'jtm_hotspot_phone';

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return '254' + digits;
  return null;
}

function formatVoucher(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hasPrefix = c.startsWith('HS');
  const rest = hasPrefix ? c.slice(2) : c;
  const groups: string[] = hasPrefix ? ['HS'] : [];
  for (let i = 0; i < rest.length; i += 4) groups.push(rest.slice(i, i + 4));
  return groups.filter(Boolean).join('-');
}

function formatValidity(days: number): string {
  if (days >= 30) return `${Math.round(days / 30)} month${days >= 60 ? 's' : ''}`;
  if (days >= 7) return `${Math.round(days / 7)} week${days >= 14 ? 's' : ''}`;
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
  const hours = Math.round(days * 24);
  return `${hours} hour${hours !== 1 ? 's' : ''}`;
}

function formatSpeed(kbps: number | null): string | null {
  if (!kbps) return null;
  if (kbps >= 1000) {
    const mbps = kbps / 1000;
    return `${mbps % 1 === 0 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
  }
  return `${kbps} Kbps`;
}

export default function HotspotPortal() {
  const [tab, setTab] = useState<Tab>('voucher');
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [planId, setPlanId] = useState('');
  const [plans, setPlans] = useState<HotspotPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [grant, setGrant] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purchase, setPurchase] = useState<PurchaseInit | null>(null);
  const [purchaseStatus, setPurchaseStatus] = useState<string>('');
  const [pollElapsed, setPollElapsed] = useState(0);
  const [mtikParams, setMtikParams] = useState<{
    linkLogin: string; mac: string; ip: string; orig: string;
    mode: 'login' | 'status' | 'logout' | 'error' | 'rlogin';
    username: string; sessionTimeLeft: string; uptime: string;
    bytesIn: string; bytesOut: string; linkLogout: string;
    mikrotikError: string;
  } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const phoneNormalized = normalizePhone(phone);
  const phoneValid = phoneNormalized !== null;
  const selectedPlan = plans.find((p) => p.id === planId) ?? null;

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const mode = (q.get('mode') ?? 'login') as 'login' | 'status' | 'logout' | 'error' | 'rlogin';
    setMtikParams({
      linkLogin: q.get('link-login-only') ?? q.get('link-login') ?? '',
      mac: q.get('mac') ?? '',
      ip: q.get('ip') ?? '',
      orig: q.get('link-orig') ?? q.get('dst') ?? '',
      mode,
      username: q.get('username') ?? '',
      sessionTimeLeft: q.get('session-time-left') ?? '',
      uptime: q.get('uptime') ?? '',
      bytesIn: q.get('bytes-in') ?? '',
      bytesOut: q.get('bytes-out') ?? '',
      linkLogout: q.get('link-logout') ?? '',
      mikrotikError: q.get('error') ?? '',
    });
    const saved = window.localStorage.getItem(PHONE_KEY);
    if (saved) setPhone(saved);
    loadPlans();
  }, []);

  const loadPlans = () => {
    setPlansLoading(true);
    setPlansError(null);
    api<HotspotPlan[]>('/hotspot/plans')
      .then((p) => {
        setPlans(p);
        if (p[0]) setPlanId(p[0].id);
      })
      .catch((e: any) => setPlansError(e.message))
      .finally(() => setPlansLoading(false));
  };

  const redeemVoucher = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<GrantResult>('/hotspot/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: code.replace(/-/g, ''), mac: mtikParams?.mac }),
      });
      setGrant(r);
      setTimeout(() => formRef.current?.submit(), 400);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const payMpesa = async () => {
    if (!phoneNormalized) {
      setError('Enter a valid Safaricom number (07XX or 2547XX).');
      return;
    }
    setSubmitting(true);
    setError(null);
    setPollElapsed(0);
    try {
      const p = await api<PurchaseInit>('/hotspot/pay', {
        method: 'POST',
        body: JSON.stringify({ plan_id: planId, phone: phoneNormalized, mac: mtikParams?.mac }),
      });
      window.localStorage.setItem(PHONE_KEY, phoneNormalized);
      setPurchase(p);
      setPurchaseStatus(p.simulated
        ? 'Simulation mode — confirming…'
        : 'STK push sent. Check your phone for the M-Pesa prompt.');
      pollPurchase(p);
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  };

  const pollPurchase = async (p: PurchaseInit) => {
    if (p.simulated) {
      try {
        await api(`/hotspot/pay/${p.checkoutRequestId}/confirm-test`, { method: 'POST' });
      } catch {/* fall through to polling */}
    }
    const start = performance.now();
    const deadline = start + 90_000;
    const tick = async () => {
      try {
        const s = await api<{ status: string; grant?: GrantResult; failureReason?: string }>(
          `/hotspot/pay/${p.checkoutRequestId}`
        );
        setPollElapsed(Math.floor((performance.now() - start) / 1000));
        if (s.status === 'success' && s.grant) {
          setGrant(s.grant);
          setSubmitting(false);
          setTimeout(() => formRef.current?.submit(), 400);
          return;
        }
        if (s.status === 'failed' || s.status === 'expired') {
          setError(`Payment ${s.status}: ${s.failureReason ?? 'unknown reason'}`);
          setSubmitting(false);
          setPurchase(null);
          return;
        }
        if (performance.now() > deadline) {
          setError('Timed out waiting for M-Pesa. Try again.');
          setSubmitting(false);
          setPurchase(null);
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

  const resendStk = () => {
    setPurchase(null);
    setPurchaseStatus('');
    setPollElapsed(0);
    payMpesa();
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ maxWidth: 460, width: '100%' }}>
        <h1 style={{ marginBottom: 4 }}>HUB Networks Wi-Fi</h1>
        <p className="sub" style={{ marginBottom: 20 }}>
          Connect with a voucher code or buy a plan via M-Pesa.
        </p>

        {mtikParams?.mode === 'status' ? (
          <>
            <div className="toast ok" style={{ marginBottom: 12 }}>You're connected</div>
            <table style={{ width: '100%', fontSize: 13, marginBottom: 16 }}>
              <tbody>
                {mtikParams.username && <tr><td className="sub">User</td><td><code>{mtikParams.username}</code></td></tr>}
                {mtikParams.ip && <tr><td className="sub">IP</td><td><code>{mtikParams.ip}</code></td></tr>}
                {mtikParams.uptime && <tr><td className="sub">Uptime</td><td>{mtikParams.uptime}</td></tr>}
                {mtikParams.sessionTimeLeft && <tr><td className="sub">Time left</td><td>{mtikParams.sessionTimeLeft}</td></tr>}
                {mtikParams.bytesIn && <tr><td className="sub">Down</td><td>{mtikParams.bytesIn}</td></tr>}
                {mtikParams.bytesOut && <tr><td className="sub">Up</td><td>{mtikParams.bytesOut}</td></tr>}
              </tbody>
            </table>
            {mtikParams.linkLogout && (
              <a href={mtikParams.linkLogout} className="btn" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>Log out</a>
            )}
          </>
        ) : mtikParams?.mode === 'logout' ? (
          <>
            <div className="toast ok" style={{ marginBottom: 12 }}>Logged out</div>
            {(mtikParams.bytesIn || mtikParams.bytesOut || mtikParams.uptime) && (
              <table style={{ width: '100%', fontSize: 13, marginBottom: 16 }}>
                <tbody>
                  {mtikParams.uptime && <tr><td className="sub">Session length</td><td>{mtikParams.uptime}</td></tr>}
                  {mtikParams.bytesIn && <tr><td className="sub">Downloaded</td><td>{mtikParams.bytesIn}</td></tr>}
                  {mtikParams.bytesOut && <tr><td className="sub">Uploaded</td><td>{mtikParams.bytesOut}</td></tr>}
                </tbody>
              </table>
            )}
            <p className="sub">Reconnect anytime with a new voucher or M-Pesa payment.</p>
          </>
        ) : grant ? (
          <>
            <div className="toast ok" style={{ marginBottom: 12 }}>
              <strong>{grant.planName}</strong> · {Math.round(grant.validitySeconds / 3600)}h
              {grant.rateLimit ? ` · ${grant.rateLimit}` : ''}
            </div>
            <p className="sub">Connecting you to the network…</p>
            <form ref={formRef} method="post" action={mtikParams?.linkLogin || '#'} style={{ display: 'none' }}>
              <input type="hidden" name="username" value={grant.username} />
              <input type="hidden" name="password" value={grant.password} />
              <input type="hidden" name="dst" value={mtikParams?.orig ?? ''} />
            </form>
            {!mtikParams?.linkLogin && (
              <div className="toast err" style={{ marginTop: 12 }}>
                No MikroTik login URL — preview mode. On a real hotspot you'd be
                logged in now.
              </div>
            )}
          </>
        ) : (
          <>
            {mtikParams?.mikrotikError && (
              <div className="toast err" style={{ marginBottom: 12 }}>
                Login error: {mtikParams.mikrotikError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: 'var(--surface)', padding: 4, borderRadius: 6 }}>
              <button
                onClick={() => { setTab('voucher'); setError(null); }}
                style={{
                  flex: 1, background: tab === 'voucher' ? 'var(--accent)' : 'transparent',
                  color: tab === 'voucher' ? '#04121f' : 'var(--text)', fontSize: 13,
                }}
              >Voucher</button>
              <button
                onClick={() => { setTab('pay'); setError(null); }}
                style={{
                  flex: 1, background: tab === 'pay' ? 'var(--accent)' : 'transparent',
                  color: tab === 'pay' ? '#04121f' : 'var(--text)', fontSize: 13,
                }}
              >Pay via M-Pesa</button>
            </div>

            {tab === 'voucher' ? (
              <>
                <label>Voucher code</label>
                <input
                  autoFocus
                  value={code}
                  placeholder="HS-XXXX-XXXX"
                  onChange={(e) => setCode(formatVoucher(e.target.value))}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{ fontSize: 18, textAlign: 'center', letterSpacing: 2 }}
                />
                <button
                  onClick={redeemVoucher}
                  disabled={code.replace(/-/g, '').length < 6 || submitting}
                  style={{ width: '100%', marginTop: 16, padding: '12px' }}
                >
                  {submitting ? 'Activating…' : 'Connect'}
                </button>
              </>
            ) : purchase ? (
              <>
                <div className="toast ok">
                  {purchaseStatus}
                  <br />
                  <small>{purchase.customerMessage}</small>
                </div>
                <p className="sub" style={{ textAlign: 'center', marginTop: 12 }}>
                  Waiting for M-Pesa… <strong>{pollElapsed}s</strong>
                </p>
                {pollElapsed >= 30 && (
                  <button
                    onClick={resendStk}
                    className="ghost"
                    style={{ width: '100%', marginTop: 12 }}
                  >
                    Didn't receive prompt? Resend
                  </button>
                )}
              </>
            ) : (
              <>
                <label>Choose a plan</label>
                {plansLoading ? (
                  <p className="sub">Loading plans…</p>
                ) : plansError ? (
                  <>
                    <div className="toast err">{plansError}</div>
                    <button onClick={loadPlans} className="ghost" style={{ width: '100%', marginTop: 8 }}>Retry</button>
                  </>
                ) : plans.length === 0 ? (
                  <p className="sub">No hotspot plans configured. Please ask staff to set up plans.</p>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {plans.map((p) => {
                      const active = p.id === planId;
                      const speed = formatSpeed(p.speed_down_kbps);
                      return (
                        <button
                          key={p.id}
                          onClick={() => setPlanId(p.id)}
                          style={{
                            background: active ? 'rgba(56,189,248,0.10)' : 'var(--surface)',
                            border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                            color: 'var(--text)',
                            padding: 14,
                            borderRadius: 8,
                            textAlign: 'left',
                            fontWeight: 400,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 10,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                            <div className="sub" style={{ fontSize: 12, marginTop: 2, marginBottom: 0 }}>
                              {formatValidity(p.validity_days)}{speed ? ` · ${speed}` : ''}
                            </div>
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 16, color: active ? 'var(--accent)' : 'var(--text)' }}>
                            KES {(p.price_cents / 100).toFixed(0)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {plans.length > 0 && (
                  <>
                    <label style={{ marginTop: 16 }}>M-Pesa phone</label>
                    <input
                      value={phone}
                      placeholder="07XX XXX XXX"
                      onChange={(e) => setPhone(e.target.value)}
                      inputMode="tel"
                      autoComplete="tel"
                    />
                    {phone && !phoneValid && (
                      <p className="sub" style={{ color: 'var(--orange)', marginTop: 4, fontSize: 11 }}>
                        Enter a Safaricom number (07XX or 2547XX).
                      </p>
                    )}
                    {phoneValid && selectedPlan && (
                      <p className="sub" style={{ marginTop: 4, fontSize: 11 }}>
                        STK push to <code>{phoneNormalized}</code> · KES {(selectedPlan.price_cents / 100).toFixed(0)}
                      </p>
                    )}
                    <button
                      onClick={payMpesa}
                      disabled={!planId || !phoneValid || submitting}
                      style={{ width: '100%', marginTop: 12, padding: '12px' }}
                    >
                      {submitting ? 'Sending STK push…' : `Pay & Connect`}
                    </button>
                  </>
                )}
              </>
            )}

            {error && <div className="toast err" style={{ marginTop: 12 }}>{error}</div>}
            {mtikParams?.mac && (
              <p className="sub" style={{ marginTop: 16, fontSize: 11, textAlign: 'center' }}>
                Device: <code>{mtikParams.mac}</code>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
