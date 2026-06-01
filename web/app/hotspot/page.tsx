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

export default function HotspotPortal() {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [grant, setGrant] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // MikroTik passes these as query params when it redirects the customer to us.
  const [mtikParams, setMtikParams] = useState<{
    linkLogin: string; mac: string; ip: string; orig: string;
  } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setMtikParams({
      linkLogin: q.get('link-login-only') ?? q.get('link-login') ?? '',
      mac: q.get('mac') ?? '',
      ip: q.get('ip') ?? '',
      orig: q.get('link-orig') ?? q.get('dst') ?? '',
    });
  }, []);

  const redeem = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<GrantResult>('/hotspot/redeem', {
        method: 'POST',
        body: JSON.stringify({ code, mac: mtikParams?.mac }),
      });
      setGrant(r);
      // Auto-submit to MikroTik's login URL with the credentials so the
      // hotspot gateway does the actual RADIUS exchange and lets us through.
      // If there's no link-login (e.g. previewing on a desktop browser
      // outside the hotspot), we just show the result for inspection.
      setTimeout(() => formRef.current?.submit(), 400);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ maxWidth: 420, width: '100%' }}>
        <h1 style={{ marginBottom: 8 }}>HUB Networks Wi-Fi</h1>
        <p className="sub" style={{ marginBottom: 24 }}>
          Enter your voucher code to connect.
        </p>

        {grant ? (
          <>
            <div className="toast ok" style={{ marginBottom: 12 }}>
              ✓ Voucher accepted — {grant.planName} ·
              {' '}{Math.round(grant.validitySeconds / 3600)}h
              {grant.rateLimit ? ` · ${grant.rateLimit}` : ''}
            </div>
            <p className="sub">Connecting you to the network…</p>
            {/* Auto-submitted form delivers credentials to MikroTik's hotspot
                gateway. MikroTik does the actual RADIUS auth + grants access. */}
            <form
              ref={formRef}
              method="post"
              action={mtikParams?.linkLogin || '#'}
              style={{ display: 'none' }}
            >
              <input type="hidden" name="username" value={grant.username} />
              <input type="hidden" name="password" value={grant.password} />
              <input type="hidden" name="dst" value={mtikParams?.orig ?? ''} />
            </form>
            {!mtikParams?.linkLogin && (
              <div className="toast err" style={{ marginTop: 12 }}>
                No MikroTik login URL was passed — you're previewing this page
                outside the captive portal. On a real hotspot dial it will
                auto-submit.
              </div>
            )}
          </>
        ) : (
          <>
            <label>Voucher code</label>
            <input
              autoFocus
              value={code}
              placeholder="e.g. HUB-X9F2-K3LM"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              style={{ fontSize: 18, textAlign: 'center', letterSpacing: 2 }}
            />
            {error && (
              <div className="toast err" style={{ marginTop: 12 }}>{error}</div>
            )}
            <button
              onClick={redeem}
              disabled={!code || submitting}
              style={{ width: '100%', marginTop: 16, padding: '12px', fontSize: 15 }}
            >
              {submitting ? 'Activating…' : 'Connect'}
            </button>
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
