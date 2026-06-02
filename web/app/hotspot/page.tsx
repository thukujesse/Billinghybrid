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

export default function HotspotPortal() {
  const [tab, setTab] = useState<Tab>('voucher');
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [planId, setPlanId] = useState('');
  const [plans, setPlans] = useState<HotspotPlan[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [grant, setGrant] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purchase, setPurchase] = useState<PurchaseInit | null>(null);
  const [purchaseStatus, setPurchaseStatus] = useState<string>('');
  const [mtikParams, setMtikParams] = useState<{
    linkLogin: string; mac: string; ip: string; orig: string;
    mode: 'login' | 'status' | 'logout' | 'error' | 'rlogin';
    username: string; sessionTimeLeft: string; uptime: string;
    bytesIn: string; bytesOut: string; linkLogout: string;
    mikrotikError: string;
  } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

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
    api<HotspotPlan[]>('/hotspot/plans')
      .then((p) => { setPlans(p); if (p[0]) setPlanId(p[0].id); })
      .catch(() => {});
  }, []);

  const redeemVoucher = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<GrantResult>('/hotspot/redeem', {
        method: 'POST',
        body: JSON.stringify({ code, mac: mtikParams?.mac }),
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
    setSubmitting(true);
    setError(null);
    try {
      const p = await api<PurchaseInit>('/hotspot/pay', {
        method: 'POST',
        body: JSON.stringify({ plan_id: planId, phone, mac: mtikParams?.mac }),
      });
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
    // If simulation mode, immediately call confirm-test so portal flow can be
    // exercised end-to-end without real Daraja credentials.
    if (p.simulated) {
      try {
        await api(`/hotspot/pay/${p.checkoutRequestId}/confirm-test`, { method: 'POST' });
      } catch {/* fall through to polling */}
    }
    const deadline = Date.now() + 90_000; // 90s timeout
    const tick = async () => {
      try {
        const s = await api<{ status: string; grant?: GrantResult; failureReason?: string }>(
          `/hotspot/pay/${p.checkoutRequestId}`
        );
        if (s.status === 'success' && s.grant) {
          setGrant(s.grant);
          setSubmitting(false);
          setTimeout(() => formRef.current?.submit(), 400);
          return;
        }
        if (s.status === 'failed' || s.status === 'expired') {
          setError(`Payment ${s.status}: ${s.failureReason ?? 'unknown reason'}`);
          setSubmitting(false);
          return;
        }
        if (Date.now() > deadline) {
          setError('Timed out waiting for M-Pesa. Please try again.');
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
      <div className="card" style={{ maxWidth: 440, width: '100%' }}>
        <h1 style={{ marginBottom: 8 }}>HUB Networks Wi-Fi</h1>
        <p className="sub" style={{ marginBottom: 20 }}>
          Connect with a voucher code or buy a plan via M-Pesa.
        </p>

        {mtikParams?.mode === 'status' ? (
          <>
            <div className="toast ok" style={{ marginBottom: 12 }}>✓ You're connected</div>
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
            <div className="toast ok" style={{ marginBottom: 12 }}>✓ Logged out</div>
            <p className="sub">Thanks for using HUB Networks Wi-Fi. Reconnect anytime with a new voucher or M-Pesa payment.</p>
          </>
        ) : grant ? (
          <>
            <div className="toast ok" style={{ marginBottom: 12 }}>
              ✓ {grant.planName} · {Math.round(grant.validitySeconds / 3600)}h
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
                  placeholder="e.g. HS-X9F2-K3LM"
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  style={{ fontSize: 18, textAlign: 'center', letterSpacing: 2 }}
                />
                <button
                  onClick={redeemVoucher}
                  disabled={!code || submitting}
                  style={{ width: '100%', marginTop: 16, padding: '12px' }}
                >
                  {submitting ? 'Activating…' : 'Connect'}
                </button>
              </>
            ) : (
              <>
                {purchase ? (
                  <div className="toast ok">
                    {purchaseStatus}
                    <br /><small>{purchase.customerMessage}</small>
                  </div>
                ) : (
                  <>
                    <label>Choose a plan</label>
                    {plans.length === 0 ? (
                      <p className="sub">No hotspot plans configured. Ask the admin to create one.</p>
                    ) : (
                      <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                        {plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} — KES {(p.price_cents / 100).toFixed(0)} · {p.validity_days}d
                            {p.speed_down_kbps ? ` · ${p.speed_down_kbps}k` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <label style={{ marginTop: 12 }}>M-Pesa phone</label>
                    <input
                      value={phone}
                      placeholder="07XX or 2547XX..."
                      onChange={(e) => setPhone(e.target.value)}
                      inputMode="tel"
                    />
                    <button
                      onClick={payMpesa}
                      disabled={!planId || !phone || submitting || plans.length === 0}
                      style={{ width: '100%', marginTop: 16, padding: '12px' }}
                    >
                      {submitting ? 'Sending STK push…' : 'Pay & Connect'}
                    </button>
                  </>
                )}
              </>
            )}

            {mtikParams?.mikrotikError && (
              <div className="toast err" style={{ marginTop: 12 }}>
                Login error: {mtikParams.mikrotikError}
              </div>
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
