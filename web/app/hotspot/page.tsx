'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
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

interface Branding {
  name: string;
  color: string;
  tagline: string;
}

type Tab = 'voucher' | 'pay';

const PHONE_KEY = 'jtm_hotspot_phone';
const TOKEN_KEY = 'jtm_hotspot_token';
const FP_KEY = 'jtm_hotspot_fp';
const DEFAULT_BRANDING: Branding = {
  name: 'HUB Networks',
  color: '#2563eb',
  tagline: 'Connect to Wi-Fi',
};

// ---------- Device-token plumbing (Sprint 2.5 silent re-auth) ----------
// Tokens survive MAC randomization where MAC-cookies + portal MAC lookup
// can't. Stored in localStorage (cookies get cleared by "clear browsing
// data" sweeps; localStorage tends to stick). Server rotates on every use.

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fingerprint inputs are deliberately the stable subset of common
 * fingerprinting signals. Excludes canvas/audio (heavy + flaky across
 * browser updates) and IP (rotates with NAT). Goal: identify the same
 * physical browser across MAC rotations, not defeat private-browsing.
 */
async function computeFingerprint(): Promise<string> {
  try {
    const parts = [
      navigator.userAgent || '',
      navigator.language || '',
      String((navigator.languages || []).slice(0, 4).join(',')),
      String(navigator.hardwareConcurrency || 0),
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      String((navigator as any).platform || ''),
    ];
    return await sha256Hex(parts.join('|'));
  } catch {
    return '';
  }
}

async function getFingerprint(): Promise<string> {
  // Recompute every call instead of caching in localStorage — an unsalted
  // cached fingerprint could be exfiltrated and replayed by an attacker on
  // a different browser, defeating future "fingerprint match" enforcement.
  // The compute is cheap (no canvas/audio probing), so this costs nothing.
  return await computeFingerprint();
}

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

// Hex → "r,g,b" so we can use rgba() with alpha for soft tints.
function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function DataCapBar({ bytesUsed, capMb, brand, brandRgb }: { bytesUsed: number; capMb: number; brand: string; brandRgb: string }) {
  const usedMb = bytesUsed / (1024 * 1024);
  const pct = Math.min(100, Math.round((usedMb / capMb) * 100));
  const remaining = Math.max(0, capMb - usedMb);
  const color = pct > 90 ? '#dc2626' : pct > 75 ? '#d97706' : brand;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginBottom: 4 }}>
        <span>{formatBytes(bytesUsed)} of {capMb >= 1024 ? `${(capMb / 1024).toFixed(1)} GB` : `${capMb} MB`}</span>
        <span><strong style={{ color }}>{pct}%</strong> · {remaining < 1024 ? `${remaining.toFixed(0)} MB` : `${(remaining / 1024).toFixed(1)} GB`} left</span>
      </div>
      <div style={{ background: `rgba(${brandRgb},0.10)`, borderRadius: 6, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.4s' }} />
      </div>
    </div>
  );
}

function hexToRgb(hex: string): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return '37,99,235';
  return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
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
  const [brand, setBrand] = useState<Branding>(DEFAULT_BRANDING);
  // Auto-grant fast path: if the connecting MAC is in active_devices we
  // skip the entire voucher/pay UI and silently log the device in.
  const [autoCheck, setAutoCheck] = useState<'idle' | 'checking' | 'unknown'>('idle');
  // Rebind flow for randomized-MAC recovery: customer paid before on a
  // different MAC; verify via SMS OTP and copy the grant onto this MAC.
  const [rebind, setRebind] = useState<{
    phase: 'closed' | 'phone' | 'otp';
    otpId: string | null;
    code: string;
    busy: boolean;
    notice: string | null;
  }>({ phase: 'closed', otpId: null, code: '', busy: false, notice: null });
  // Rich session data fetched from the API for the status tab (plan name,
  // voucher id, data cap, bytes used). MikroTik's $(var) substitution gives
  // us uptime/time-left/bytes; the API gives us the plan context.
  const [sessionInfo, setSessionInfo] = useState<{
    planName: string | null;
    voucherId: string | null;
    expiresAt: string | null;
    secondsRemaining: number | null;
    rateLimit: string | null;
    dataCapMb: number | null;
    bytesUsed: number;
    phone: string | null;
  } | null>(null);
  const [mtikParams, setMtikParams] = useState<{
    linkLogin: string; mac: string; ip: string; orig: string;
    mode: 'login' | 'status' | 'logout' | 'error' | 'rlogin';
    username: string; sessionTimeLeft: string; uptime: string;
    bytesIn: string; bytesOut: string; linkLogout: string;
    mikrotikError: string; tenant: string;
  } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const phoneNormalized = normalizePhone(phone);
  const phoneValid = phoneNormalized !== null;
  const selectedPlan = plans.find((p) => p.id === planId) ?? null;
  const brandRgb = hexToRgb(brand.color);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const mode = (q.get('mode') ?? 'login') as 'login' | 'status' | 'logout' | 'error' | 'rlogin';
    const tenant = q.get('tenant') ?? '';
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
      tenant,
    });
    const saved = window.localStorage.getItem(PHONE_KEY);
    if (saved) setPhone(saved);
    if (tenant) {
      api<Branding>(`/hotspot/branding/${encodeURIComponent(tenant)}`)
        .then(setBrand)
        .catch(() => {/* fall through to default */});
    }
    loadPlans();
  }, []);

  // Status-mode enrichment: fetch plan name, voucher id, data cap, bytes
  // used so the status table is informative, not just a list of bytes.
  useEffect(() => {
    if (!mtikParams?.mac || mtikParams.mode !== 'status') return;
    api<{ found: boolean } & NonNullable<typeof sessionInfo>>(
      `/hotspot/session-info?mac=${encodeURIComponent(mtikParams.mac)}`
    )
      .then((r) => { if (r.found) setSessionInfo(r); })
      .catch(() => {/* status table still works without enrichment */});
  }, [mtikParams?.mac, mtikParams?.mode]);

  // Returning-customer auto-grant: tiered fallback.
  //   1) MAC lookup — fastest, works for stable-MAC devices (most laptops).
  //   2) Device token (Sprint 2.5) — survives MAC randomization. We hand
  //      the token + a browser fingerprint; server finds the phone's live
  //      grant, rebinds onto this MAC, rotates the token.
  //   3) Fall through to manual UI (voucher / pay / "recover via SMS").
  useEffect(() => {
    if (!mtikParams?.mac || mtikParams.mode !== 'login') return;
    setAutoCheck('checking');
    let cancelled = false;

    const handleGrant = (
      r: { username?: string; password?: string; validitySeconds?: number; secondsRemaining?: number; rateLimit?: string | null; phone?: string | null },
      planName: string
    ) => {
      if (cancelled) return;
      setGrant({
        username: r.username!,
        password: r.password!,
        validitySeconds: r.secondsRemaining ?? r.validitySeconds ?? 0,
        rateLimit: r.rateLimit ?? null,
        planName,
      });
      if (r.phone) setPhone(r.phone);
      setTimeout(() => formRef.current?.submit(), 400);
    };

    (async () => {
      // Step 1: MAC lookup.
      try {
        const mac = await api<{
          active: boolean; username?: string; password?: string;
          validitySeconds?: number; secondsRemaining?: number; rateLimit?: string | null;
          phone?: string | null;
        }>(`/hotspot/lookup?mac=${encodeURIComponent(mtikParams.mac!)}`);
        if (mac.active && mac.username && mac.password) {
          handleGrant(mac, 'Welcome back');
          // No token mint here — /hotspot/lookup accepts a spoofable MAC
          // and is not an authenticated event. Token mint happens only
          // on M-Pesa success (proves PIN) or SMS-OTP rebind (proves
          // possession). Pre-2.5 customers using a stable MAC get
          // tokenless re-auth and pick up a token on their next purchase.
          return;
        }
      } catch {/* fall through to token path */}

      // Step 2: device token (silent rebind for randomized MAC).
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored) {
        try {
          const fp = await getFingerprint();
          const tok = await api<{
            active: boolean; username?: string; password?: string;
            validitySeconds?: number; secondsRemaining?: number; rateLimit?: string | null;
            phone?: string | null; token?: string; reason?: string;
          }>('/hotspot/auto-reconnect', {
            method: 'POST',
            body: JSON.stringify({ token: stored, mac: mtikParams.mac, fingerprint: fp || undefined }),
          });
          if (tok.active && tok.username && tok.password) {
            if (tok.token) localStorage.setItem(TOKEN_KEY, tok.token);
            handleGrant(tok, 'Welcome back');
            return;
          }
          // Server explicitly revoked or expired our token — clear it so we
          // don't keep retrying. grant_expired leaves the token in place
          // since the customer can repay and it'll work next time.
          if (tok.reason === 'no_match' || tok.reason === 'revoked' || tok.reason === 'expired') {
            localStorage.removeItem(TOKEN_KEY);
          }
        } catch {/* fall through to manual UI */}
      }

      // Step 3: nothing matched — show payment UI.
      if (!cancelled) setAutoCheck('unknown');
    })();

    return () => { cancelled = true; };
  }, [mtikParams?.mac, mtikParams?.mode]);

  const rebindStart = async () => {
    if (!phoneNormalized) {
      setRebind((r) => ({ ...r, notice: 'Enter a valid Safaricom number first.' }));
      return;
    }
    if (!mtikParams?.mac) {
      setRebind((r) => ({ ...r, notice: 'No device MAC available.' }));
      return;
    }
    setRebind((r) => ({ ...r, busy: true, notice: null }));
    try {
      const res = await api<{ otpId: string; message: string }>('/hotspot/rebind/start', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneNormalized, mac: mtikParams.mac }),
      });
      setRebind({ phase: 'otp', otpId: res.otpId, code: '', busy: false, notice: res.message });
    } catch (e: any) {
      setRebind((r) => ({ ...r, busy: false, notice: e.message }));
    }
  };

  const rebindVerify = async () => {
    if (!rebind.otpId || rebind.code.length < 4) return;
    setRebind((r) => ({ ...r, busy: true, notice: null }));
    try {
      const res = await api<{
        active: boolean; username: string; password: string;
        validitySeconds: number; rateLimit: string | null;
        token?: string;
      }>('/hotspot/rebind/verify', {
        method: 'POST',
        body: JSON.stringify({ otpId: rebind.otpId, code: rebind.code }),
      });
      if (res.active) {
        setGrant({
          username: res.username,
          password: res.password,
          validitySeconds: res.validitySeconds,
          rateLimit: res.rateLimit,
          planName: 'Welcome back',
        });
        // Inline-minted token comes back from the verify response. We just
        // store what the server hands us — no separate API call.
        if (res.token) localStorage.setItem(TOKEN_KEY, res.token);
        setTimeout(() => formRef.current?.submit(), 400);
      }
    } catch (e: any) {
      setRebind((r) => ({ ...r, busy: false, notice: e.message }));
    }
  };

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
      // Vouchers don't mint tokens (no phone associated with redemption).
      // Voucher customers reconnect via MikroTik MAC cookie / MAC-auth.
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
          // Inline-minted token piggybacks on the success poll response.
          if ((s as any).token) localStorage.setItem(TOKEN_KEY, (s as any).token);
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

  // Dynamic per-state styles. Pulled out of `styles` so the Record<string,
  // CSSProperties> annotation below stays valid (functions don't fit it).
  const tabStyle = (active: boolean): CSSProperties => ({
    flex: 1,
    background: active ? '#ffffff' : 'transparent',
    color: active ? brand.color : '#64748b',
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 12px',
    borderRadius: 7,
    border: 'none',
    cursor: 'pointer',
    boxShadow: active ? '0 1px 2px rgba(15,23,42,0.08)' : 'none',
  });
  const planCardStyle = (active: boolean): CSSProperties => ({
    background: active ? `rgba(${brandRgb},0.06)` : '#ffffff',
    border: `1px solid ${active ? brand.color : '#e2e8f0'}`,
    borderRadius: 10,
    padding: 14,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  });

  // CSS variables drive the theme — only the brand colour changes per tenant.
  // Light, minimal palette: white card on a soft tinted background.
  const styles: Record<string, CSSProperties> = {
    page: {
      minHeight: '100vh',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
      background: `linear-gradient(180deg, rgba(${brandRgb},0.04) 0%, #f8fafc 100%)`,
      color: '#0f172a',
      fontFamily: "'Inter', system-ui, -apple-system, 'Plus Jakarta Sans', sans-serif",
    },
    card: {
      maxWidth: 440,
      width: '100%',
      background: '#ffffff',
      border: '1px solid #e2e8f0',
      borderRadius: 16,
      padding: 28,
      boxShadow: '0 1px 3px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.04)',
    },
    wordmark: {
      fontSize: 28,
      fontWeight: 800,
      letterSpacing: '-0.02em',
      color: brand.color,
      margin: 0,
    },
    tagline: {
      fontSize: 14,
      color: '#64748b',
      marginTop: 4,
      marginBottom: 24,
    },
    tabs: {
      display: 'flex',
      gap: 4,
      marginBottom: 20,
      background: '#f1f5f9',
      padding: 4,
      borderRadius: 10,
    },
    label: {
      display: 'block',
      fontSize: 12,
      fontWeight: 500,
      color: '#475569',
      marginTop: 12,
      marginBottom: 6,
    },
    input: {
      width: '100%',
      background: '#ffffff',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: '11px 14px',
      fontSize: 14,
      color: '#0f172a',
      outline: 'none',
    },
    voucherInput: {
      textAlign: 'center' as const,
      fontSize: 18,
      letterSpacing: 2,
      fontWeight: 600,
    },
    btnPrimary: {
      width: '100%',
      background: brand.color,
      color: '#ffffff',
      border: 'none',
      borderRadius: 8,
      padding: 13,
      fontSize: 14,
      fontWeight: 600,
      cursor: 'pointer',
      marginTop: 16,
    },
    btnGhost: {
      width: '100%',
      background: 'transparent',
      color: '#475569',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: 11,
      fontSize: 13,
      fontWeight: 500,
      cursor: 'pointer',
      marginTop: 12,
    },
    okToast: {
      background: 'rgba(22,163,74,0.10)',
      color: '#15803d',
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: 13,
      marginBottom: 12,
    },
    errToast: {
      background: 'rgba(220,38,38,0.08)',
      color: '#b91c1c',
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: 13,
      marginTop: 12,
    },
    sub: { fontSize: 12, color: '#64748b', margin: 0 },
    code: { fontFamily: 'ui-monospace, monospace', background: '#f1f5f9', padding: '1px 6px', borderRadius: 4, fontSize: 12 },
    footer: { marginTop: 24, textAlign: 'center' as const, fontSize: 11, color: '#94a3b8' },
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.wordmark}>{brand.name}</h1>
        <p style={styles.tagline}>{brand.tagline}</p>

        {mtikParams?.mode === 'status' ? (
          <>
            <div style={styles.okToast}>
              You're connected
              {sessionInfo?.planName && <> · <strong>{sessionInfo.planName}</strong></>}
            </div>

            {sessionInfo?.dataCapMb && (
              <DataCapBar bytesUsed={sessionInfo.bytesUsed} capMb={sessionInfo.dataCapMb} brand={brand.color} brandRgb={brandRgb} />
            )}

            <table style={{ width: '100%', fontSize: 13 }}>
              <tbody>
                {sessionInfo?.voucherId && <tr><td style={styles.sub}>Voucher</td><td><code style={styles.code}>{sessionInfo.voucherId}</code></td></tr>}
                {sessionInfo?.phone && <tr><td style={styles.sub}>Phone</td><td><code style={styles.code}>{sessionInfo.phone}</code></td></tr>}
                {mtikParams.username && <tr><td style={styles.sub}>Login</td><td><code style={styles.code}>{mtikParams.username}</code></td></tr>}
                {mtikParams.ip && <tr><td style={styles.sub}>IP</td><td><code style={styles.code}>{mtikParams.ip}</code></td></tr>}
                {mtikParams.uptime && <tr><td style={styles.sub}>Uptime</td><td>{mtikParams.uptime}</td></tr>}
                {mtikParams.sessionTimeLeft && <tr><td style={styles.sub}>Time left</td><td>{mtikParams.sessionTimeLeft}</td></tr>}
                {sessionInfo?.expiresAt && !mtikParams.sessionTimeLeft && (
                  <tr><td style={styles.sub}>Expires</td><td>{new Date(sessionInfo.expiresAt).toLocaleString()}</td></tr>
                )}
                {sessionInfo?.rateLimit && <tr><td style={styles.sub}>Speed</td><td>{sessionInfo.rateLimit}</td></tr>}
                {mtikParams.bytesIn && <tr><td style={styles.sub}>Down</td><td>{mtikParams.bytesIn}</td></tr>}
                {mtikParams.bytesOut && <tr><td style={styles.sub}>Up</td><td>{mtikParams.bytesOut}</td></tr>}
                {!mtikParams.bytesIn && sessionInfo && sessionInfo.bytesUsed > 0 && (
                  <tr><td style={styles.sub}>Used</td><td>{formatBytes(sessionInfo.bytesUsed)}</td></tr>
                )}
              </tbody>
            </table>
            {mtikParams.linkLogout && (
              <a href={mtikParams.linkLogout} style={{ ...styles.btnPrimary, display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 16 }}>Log out</a>
            )}
          </>
        ) : mtikParams?.mode === 'logout' ? (
          <>
            <div style={styles.okToast}>Logged out</div>
            {(mtikParams.bytesIn || mtikParams.bytesOut || mtikParams.uptime) && (
              <table style={{ width: '100%', fontSize: 13, marginBottom: 12 }}>
                <tbody>
                  {mtikParams.uptime && <tr><td style={styles.sub}>Session length</td><td>{mtikParams.uptime}</td></tr>}
                  {mtikParams.bytesIn && <tr><td style={styles.sub}>Downloaded</td><td>{mtikParams.bytesIn}</td></tr>}
                  {mtikParams.bytesOut && <tr><td style={styles.sub}>Uploaded</td><td>{mtikParams.bytesOut}</td></tr>}
                </tbody>
              </table>
            )}
            <p style={styles.sub}>Reconnect anytime with a new voucher or M-Pesa payment.</p>
          </>
        ) : grant ? (
          <>
            <div style={styles.okToast}>
              <strong>{grant.planName}</strong> · {Math.round(grant.validitySeconds / 3600)}h
              {grant.rateLimit ? ` · ${grant.rateLimit}` : ''}
            </div>
            <p style={styles.sub}>Connecting you to the network…</p>
            <form ref={formRef} method="post" action={mtikParams?.linkLogin || '#'} style={{ display: 'none' }}>
              <input type="hidden" name="username" value={grant.username} />
              <input type="hidden" name="password" value={grant.password} />
              <input type="hidden" name="dst" value={mtikParams?.orig ?? ''} />
            </form>
            {!mtikParams?.linkLogin && (
              <div style={styles.errToast}>
                No MikroTik login URL — preview mode. On a real hotspot you'd be logged in now.
              </div>
            )}
          </>
        ) : autoCheck === 'checking' ? (
          <>
            <div style={styles.okToast}>Checking for your existing subscription…</div>
            <p style={styles.sub}>One moment.</p>
          </>
        ) : (
          <>
            {mtikParams?.mikrotikError && (
              <div style={styles.errToast}>Login error: {mtikParams.mikrotikError}</div>
            )}

            {rebind.phase !== 'closed' && (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, marginBottom: 16 }}>
                <strong style={{ fontSize: 14 }}>Recover your subscription</strong>
                <p style={{ ...styles.sub, marginTop: 4, marginBottom: 12 }}>
                  Phone changed its Wi-Fi address? Enter the M-Pesa number you paid with and we'll re-link this device.
                </p>
                {rebind.phase === 'phone' ? (
                  <>
                    <label style={styles.label}>M-Pesa phone</label>
                    <input
                      value={phone}
                      placeholder="07XX XXX XXX"
                      onChange={(e) => setPhone(e.target.value)}
                      inputMode="tel"
                      autoComplete="tel"
                      style={styles.input}
                    />
                    <button onClick={rebindStart} disabled={!phoneValid || rebind.busy} style={{ ...styles.btnPrimary, opacity: !phoneValid || rebind.busy ? 0.5 : 1 }}>
                      {rebind.busy ? 'Sending…' : 'Send code'}
                    </button>
                  </>
                ) : (
                  <>
                    <label style={styles.label}>Enter the 6-digit code we just sent</label>
                    <input
                      autoFocus
                      value={rebind.code}
                      placeholder="123456"
                      onChange={(e) => setRebind((r) => ({ ...r, code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                      inputMode="numeric"
                      style={{ ...styles.input, fontSize: 18, textAlign: 'center', letterSpacing: 4 }}
                    />
                    <button onClick={rebindVerify} disabled={rebind.code.length < 6 || rebind.busy} style={{ ...styles.btnPrimary, opacity: rebind.code.length < 6 || rebind.busy ? 0.5 : 1 }}>
                      {rebind.busy ? 'Verifying…' : 'Verify & connect'}
                    </button>
                  </>
                )}
                {rebind.notice && <p style={{ ...styles.sub, marginTop: 8, color: '#0f172a' }}>{rebind.notice}</p>}
                <button onClick={() => setRebind({ phase: 'closed', otpId: null, code: '', busy: false, notice: null })} style={{ ...styles.btnGhost, marginTop: 8 }}>Cancel</button>
              </div>
            )}

            <div style={styles.tabs}>
              <button onClick={() => { setTab('voucher'); setError(null); }} style={tabStyle(tab === 'voucher')}>Voucher</button>
              <button onClick={() => { setTab('pay'); setError(null); }} style={tabStyle(tab === 'pay')}>Pay via M-Pesa</button>
            </div>

            {tab === 'voucher' ? (
              <>
                <label style={styles.label}>Voucher code</label>
                <input
                  autoFocus
                  value={code}
                  placeholder="HS-XXXX-XXXX"
                  onChange={(e) => setCode(formatVoucher(e.target.value))}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{ ...styles.input, ...styles.voucherInput }}
                />
                <button
                  onClick={redeemVoucher}
                  disabled={code.replace(/-/g, '').length < 6 || submitting}
                  style={{ ...styles.btnPrimary, opacity: code.replace(/-/g, '').length < 6 || submitting ? 0.5 : 1 }}
                >
                  {submitting ? 'Activating…' : 'Connect'}
                </button>
              </>
            ) : purchase ? (
              <>
                <div style={styles.okToast}>
                  {purchaseStatus}
                  <br />
                  <small>{purchase.customerMessage}</small>
                </div>
                <p style={{ ...styles.sub, textAlign: 'center', marginTop: 12 }}>
                  Waiting for M-Pesa… <strong>{pollElapsed}s</strong>
                </p>
                {pollElapsed >= 30 && (
                  <button onClick={resendStk} style={styles.btnGhost}>Didn't receive prompt? Resend</button>
                )}
              </>
            ) : (
              <>
                <label style={styles.label}>Choose a plan</label>
                {plansLoading ? (
                  <p style={styles.sub}>Loading plans…</p>
                ) : plansError ? (
                  <>
                    <div style={styles.errToast}>{plansError}</div>
                    <button onClick={loadPlans} style={styles.btnGhost}>Retry</button>
                  </>
                ) : plans.length === 0 ? (
                  <p style={styles.sub}>No hotspot plans configured. Please ask staff to set up plans.</p>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {plans.map((p) => {
                      const active = p.id === planId;
                      const speed = formatSpeed(p.speed_down_kbps);
                      return (
                        <button key={p.id} onClick={() => setPlanId(p.id)} style={planCardStyle(active)}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>{p.name}</div>
                            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                              {formatValidity(p.validity_days)}{speed ? ` · ${speed}` : ''}
                            </div>
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 16, color: active ? brand.color : '#0f172a' }}>
                            KES {(p.price_cents / 100).toFixed(0)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {plans.length > 0 && (
                  <>
                    <label style={styles.label}>M-Pesa phone</label>
                    <input
                      value={phone}
                      placeholder="07XX XXX XXX"
                      onChange={(e) => setPhone(e.target.value)}
                      inputMode="tel"
                      autoComplete="tel"
                      style={styles.input}
                    />
                    {phone && !phoneValid && (
                      <p style={{ ...styles.sub, color: '#d97706', marginTop: 6 }}>
                        Enter a Safaricom number (07XX or 2547XX).
                      </p>
                    )}
                    {phoneValid && selectedPlan && (
                      <p style={{ ...styles.sub, marginTop: 6 }}>
                        STK push to <code style={styles.code}>{phoneNormalized}</code> · KES {(selectedPlan.price_cents / 100).toFixed(0)}
                      </p>
                    )}
                    <button
                      onClick={payMpesa}
                      disabled={!planId || !phoneValid || submitting}
                      style={{ ...styles.btnPrimary, opacity: !planId || !phoneValid || submitting ? 0.5 : 1 }}
                    >
                      {submitting ? 'Sending STK push…' : 'Pay & Connect'}
                    </button>
                  </>
                )}
              </>
            )}

            {error && <div style={styles.errToast}>{error}</div>}

            {rebind.phase === 'closed' && !purchase && (
              <p style={{ ...styles.sub, marginTop: 16, textAlign: 'center' }}>
                Already paid on another device?{' '}
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); setRebind({ phase: 'phone', otpId: null, code: '', busy: false, notice: null }); }}
                  style={{ color: brand.color, textDecoration: 'none', fontWeight: 600 }}
                >
                  Recover via SMS
                </a>
              </p>
            )}
          </>
        )}

        <div style={styles.footer}>
          Powered by HUB Networks
          {mtikParams?.mac && <> · <code style={styles.code}>{mtikParams.mac}</code></>}
        </div>
      </div>
    </div>
  );
}
