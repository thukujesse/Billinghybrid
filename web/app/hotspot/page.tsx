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
  validity_minutes: number | null;
  data_cap_mb: number | null;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
}

interface AdPublic {
  id: string;
  title: string;
  media_type: 'image' | 'video';
  media_url: string;
  link_url: string | null;
}

interface PurchaseInit {
  checkoutRequestId: string;
  amountKes: number;
  customerMessage: string;
  simulated: boolean;
  // Present only for the C2B (pay-bill) flow:
  payInstructions?: { method: 'paybill'; paybill: string; account: string; amountKes: number };
}

type HotspotTemplate = 'classic' | 'aurora' | 'minimal' | 'sunset';
interface Branding {
  name: string;
  color: string;
  tagline: string;
  logoUrl: string | null;
  template: HotspotTemplate;
}

type Expanded = 'quick' | 'voucher' | null;

const PHONE_KEY = 'jtm_hotspot_phone';
const TOKEN_KEY = 'jtm_hotspot_token';
const AUTO_ATTEMPTS_KEY = 'jtm_hotspot_auto_attempts';

// Loop-guard: count auto-submit attempts in the last 60s. After 3, the
// auto-grant useEffect bails out and the customer sees the manual UI
// with an explanation. Without this guard, a RADIUS rejection (e.g.
// FreeRADIUS authorize_check_query override not deployed, MAC case
// mismatch, walled-garden block on the API host) traps the browser in
// an infinite captive→form-submit→captive cycle.
function recentAutoAttempts(): number {
  try {
    const raw = sessionStorage.getItem(AUTO_ATTEMPTS_KEY);
    if (!raw) return 0;
    const arr: number[] = JSON.parse(raw);
    const cutoff = Date.now() - 60_000;
    return arr.filter((t) => t > cutoff).length;
  } catch { return 0; }
}
function recordAutoAttempt(): void {
  try {
    const raw = sessionStorage.getItem(AUTO_ATTEMPTS_KEY);
    const arr: number[] = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - 60_000;
    const trimmed = arr.filter((t) => t > cutoff);
    trimmed.push(Date.now());
    sessionStorage.setItem(AUTO_ATTEMPTS_KEY, JSON.stringify(trimmed));
  } catch {}
}
function clearAutoAttempts(): void {
  try { sessionStorage.removeItem(AUTO_ATTEMPTS_KEY); } catch {}
}
const DEFAULT_BRANDING: Branding = {
  name: 'HUB Networks',
  color: '#2563eb',
  tagline: 'Connect to Wi-Fi',
  logoUrl: null,
  template: 'classic',
};

/** Per-template visual overrides — all driven by the brand color. Layout stays
 *  the same; the background, card and wordmark change the whole feel. */
function templateLook(template: HotspotTemplate, color: string, rgb: string) {
  switch (template) {
    case 'aurora':
      return {
        pageBg: `linear-gradient(160deg, ${color} 0%, rgba(${rgb},0.6) 50%, #0b1220 135%)`,
        pageColor: '#0f172a',
        cardBg: '#ffffff', cardBorder: 'none',
        cardShadow: '0 24px 60px rgba(0,0,0,0.35)',
        wordmark: color,
      };
    case 'minimal':
      return {
        pageBg: '#f4f6f9',
        pageColor: '#0f172a',
        cardBg: '#ffffff', cardBorder: '1px solid #e5e9f0',
        cardShadow: 'none',
        wordmark: '#0f172a',
      };
    case 'sunset':
      return {
        pageBg: `linear-gradient(160deg, rgba(${rgb},0.20) 0%, #fff7ed 48%, #fef2f2 100%)`,
        pageColor: '#0f172a',
        cardBg: 'rgba(255,255,255,0.88)', cardBorder: '1px solid rgba(255,255,255,0.7)',
        cardShadow: '0 16px 44px rgba(15,23,42,0.13)',
        wordmark: color,
      };
    case 'classic':
    default:
      return {
        pageBg: `linear-gradient(180deg, rgba(${rgb},0.04) 0%, #f8fafc 100%)`,
        pageColor: '#0f172a',
        cardBg: '#ffffff', cardBorder: '1px solid #e2e8f0',
        cardShadow: '0 1px 3px rgba(15,23,42,0.05), 0 12px 32px rgba(15,23,42,0.07)',
        wordmark: color,
      };
  }
}

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
/**
 * Canvas-based fingerprint (v2). Renders a fixed string into a 2D canvas
 * and hashes the resulting pixel data alongside the navigator fields.
 * The canvas output differs per device because of:
 *   - GPU + driver
 *   - Sub-pixel rendering + anti-aliasing settings
 *   - Installed font set + font-substitution rules
 *   - Browser version's text-shaping engine
 * Two iPhones running the same iOS version on the same Safari version
 * STILL produce different canvas hashes because the GPU contributes.
 *
 * v2 prefix versions the algorithm — stored v1 hashes (no canvas) never
 * accidentally match v2 hashes. If we ever change the algorithm again,
 * bump the prefix and customers re-fingerprint on next payment.
 */
async function computeFingerprint(): Promise<string> {
  try {
    let canvasFp = '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 220;
      canvas.height = 30;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Two overlapping text renders + a coloured rectangle force the GPU
        // through enough paths that variation surfaces. The exact strings
        // don't matter as long as they're stable across runs.
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('hub_hotspot_fp', 2, 15);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fillText('hub_hotspot_fp', 4, 17);
        canvasFp = canvas.toDataURL();
      }
    } catch {
      // Canvas blocked (some privacy extensions) — fall back to navigator-only.
    }
    const parts = [
      navigator.userAgent || '',
      navigator.language || '',
      String((navigator.languages || []).slice(0, 4).join(',')),
      String(navigator.hardwareConcurrency || 0),
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      String((navigator as any).platform || ''),
      canvasFp,
    ];
    const hash = await sha256Hex(parts.join('|'));
    return 'fp_v2_' + hash;
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

/** Friendly duration from the canonical minutes (falls back to days for legacy). */
function formatDuration(minutes: number | null, days: number): string {
  const m = minutes ?? days * 1440;
  if (m % 43200 === 0) { const v = m / 43200; return `${v} month${v > 1 ? 's' : ''}`; }
  if (m % 10080 === 0) { const v = m / 10080; return `${v} week${v > 1 ? 's' : ''}`; }
  if (m % 1440 === 0) { const v = m / 1440; return `${v} day${v > 1 ? 's' : ''}`; }
  if (m % 60 === 0) { const v = m / 60; return `${v} hour${v > 1 ? 's' : ''}`; }
  return `${m} min`;
}

/** Friendly data cap (5120 MB → "5 GB", null → "Unlimited"). */
function formatData(mb: number | null): string {
  if (!mb) return 'Unlimited';
  if (mb >= 1024) { const gb = mb / 1024; return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`; }
  return `${mb} MB`;
}

/** Bucket a package by duration so the portal can group them. */
type PlanCat = 'Hourly' | 'Daily' | 'Weekly' | 'Monthly';
const PLAN_CATS: PlanCat[] = ['Hourly', 'Daily', 'Weekly', 'Monthly'];
function planCategory(p: HotspotPlan): PlanCat {
  const m = p.validity_minutes ?? p.validity_days * 1440;
  if (m < 1440) return 'Hourly';   // under a day (minutes / hours)
  if (m < 10080) return 'Daily';   // 1–6 days
  if (m < 43200) return 'Weekly';  // 7–29 days
  return 'Monthly';                // 30+ days
}

/** Rotating sponsor banner. Cycles every 6s, records an impression per view and
 *  a click on tap. Renders nothing when there are no active ads. */
function AdBanner({ ads }: { ads: AdPublic[] }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [ads.length]);
  useEffect(() => {
    if (ads.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % ads.length), 6000);
    return () => clearInterval(t);
  }, [ads.length]);
  useEffect(() => {
    const ad = ads[idx];
    if (ad) api(`/hotspot/ads/${ad.id}/impression`, { method: 'POST' }).catch(() => {});
  }, [idx, ads]);
  if (!ads.length) return null;
  const ad = ads[idx];
  const onClick = () => {
    api(`/hotspot/ads/${ad.id}/click`, { method: 'POST' }).catch(() => {});
    if (ad.link_url) window.open(ad.link_url, '_blank', 'noopener');
  };
  return (
    <div style={{ marginBottom: 4, marginTop: 4 }}>
      <div
        onClick={ad.link_url ? onClick : undefined}
        style={{ cursor: ad.link_url ? 'pointer' : 'default', borderRadius: 12, overflow: 'hidden', border: '1px solid #e8edf3', position: 'relative', background: '#f1f5f9' }}
      >
        {ad.media_type === 'video' ? (
          <video src={ad.media_url} autoPlay muted loop playsInline style={{ width: '100%', display: 'block', maxHeight: 150, objectFit: 'cover' }} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.media_url} alt={ad.title} style={{ width: '100%', display: 'block', maxHeight: 150, objectFit: 'cover' }} />
        )}
        <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 9, color: '#fff', background: 'rgba(0,0,0,0.45)', padding: '1px 6px', borderRadius: 4, letterSpacing: 0.4 }}>Ad</span>
      </div>
      {ads.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginTop: 6 }}>
          {ads.map((_, i) => (
            <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: i === idx ? '#475569' : '#cbd5e1' }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Post-payment sponsor interstitial: "Payment successful → activating →
 *  [short clip] → connect". Never traps the customer — auto-connects after the
 *  video ends, on skip, or after an 8s safety timeout. */
function PostPayAd({ ad, onDone }: { ad: AdPublic; onDone: () => void }) {
  useEffect(() => {
    api(`/hotspot/ads/${ad.id}/impression`, { method: 'POST' }).catch(() => {});
    const safety = setTimeout(onDone, 8000); // never block on a stalled video
    return () => clearTimeout(safety);
  }, [ad.id, onDone]);
  const onAdClick = () => {
    api(`/hotspot/ads/${ad.id}/click`, { method: 'POST' }).catch(() => {});
    if (ad.link_url) window.open(ad.link_url, '_blank', 'noopener');
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: '#0b1220',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 20, color: '#fff', textAlign: 'center',
    }}>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 2 }}>Payment successful ✓</div>
      <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 18 }}>Activating your internet…</div>
      <div onClick={ad.link_url ? onAdClick : undefined}
        style={{ width: '100%', maxWidth: 360, borderRadius: 14, overflow: 'hidden', position: 'relative', cursor: ad.link_url ? 'pointer' : 'default', background: '#000' }}>
        {ad.media_type === 'video' ? (
          <video src={ad.media_url} autoPlay muted playsInline onEnded={onDone} style={{ width: '100%', display: 'block' }} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.media_url} alt={ad.title} style={{ width: '100%', display: 'block' }} />
        )}
        <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 9, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '1px 6px', borderRadius: 4 }}>Ad</span>
      </div>
      <button onClick={onDone} style={{
        marginTop: 18, background: 'transparent', color: '#fff',
        border: '1px solid rgba(255,255,255,0.4)', borderRadius: 8, padding: '8px 18px', fontSize: 13, cursor: 'pointer',
      }}>Skip &amp; connect →</button>
    </div>
  );
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

function CollapsibleBar({
  open, onToggle, brand, brandRgb, label, hint, children,
}: {
  open: boolean;
  onToggle: () => void;
  brand: string;
  brandRgb: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      marginBottom: 10,
      background: open ? `rgba(${brandRgb},0.04)` : '#ffffff',
      border: `1px solid ${open ? `rgba(${brandRgb},0.25)` : '#e2e8f0'}`,
      borderRadius: 10,
      overflow: 'hidden',
      transition: 'background 0.15s',
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '12px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: open ? brand : '#0f172a' }}>{label}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 300 }}>{hint}</div>
        </div>
        <span style={{ fontSize: 18, color: open ? brand : '#94a3b8', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', lineHeight: 1 }}>⌄</span>
      </button>
      {open && (
        <div style={{ padding: '4px 14px 14px 14px', borderTop: `1px solid rgba(${brandRgb},0.18)` }}>
          {children}
        </div>
      )}
    </div>
  );
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
  // Which collapsible section is open above the plan cards.
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [planId, setPlanId] = useState('');
  const [plans, setPlans] = useState<HotspotPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [planCat, setPlanCat] = useState<'All' | PlanCat>('All');
  const [ads, setAds] = useState<AdPublic[]>([]);
  const [postAds, setPostAds] = useState<AdPublic[]>([]);
  const [showPostAd, setShowPostAd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [grant, setGrant] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purchase, setPurchase] = useState<PurchaseInit | null>(null);
  const [purchaseStatus, setPurchaseStatus] = useState<string>('');
  // Which payment flow the ISP configured. stk/intasend/kopokopo = STK prompt;
  // paybill/till/bank = pay-by-reference (instructions card, longer poll).
  type PayMethod = 'stk' | 'paybill' | 'till' | 'bank' | 'intasend' | 'kopokopo';
  const [payMethod, setPayMethod] = useState<PayMethod>('stk');
  const [payDest, setPayDest] = useState<{ paybill: string; till: string; accountName: string }>({ paybill: '', till: '', accountName: '' });
  // Pay-by-reference methods (customer types a reference as the account).
  const isInstrPay = payMethod === 'paybill' || payMethod === 'till' || payMethod === 'bank';
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
  // Prefer a video for the post-payment slot, else the first post-payment ad.
  const postAd = postAds.find((a) => a.media_type === 'video') ?? postAds[0] ?? null;
  // Group packages by duration; only show the tab bar when >1 category exists.
  const presentCats = PLAN_CATS.filter((c) => plans.some((p) => planCategory(p) === c));
  const showCatTabs = presentCats.length > 1;
  const visiblePlans = showCatTabs && planCat !== 'All'
    ? plans.filter((p) => planCategory(p) === planCat)
    : plans;
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
    // Per-router slug overrides the global default. Empty slug uses the
    // global Settings → Hotspot Template singleton.
    api<Branding>(tenant ? `/hotspot/branding/${encodeURIComponent(tenant)}` : '/hotspot/branding')
      .then(setBrand)
      .catch(() => {/* fall through to hard-coded default */});
    loadPlans();
  }, []);

  // Status-mode enrichment: fetch plan name, voucher id, data cap, bytes
  // used so the status table is informative, not just a list of bytes.
  // Also: customer is online, so wipe the loop-guard attempts counter —
  // the next captive load (e.g. tomorrow) starts fresh.
  useEffect(() => {
    if (mtikParams?.mode === 'status' || mtikParams?.mode === 'logout') {
      clearAutoAttempts();
    }
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

    // Loop guard 1: MikroTik told us the previous login attempt failed.
    // It does this by redirecting back to the captive with ?error=... in
    // the URL. Don't auto-retry — the same auth will fail the same way.
    if (mtikParams.mikrotikError) {
      setAutoCheck('unknown');
      setError(`Auto-login failed: ${mtikParams.mikrotikError}. Try Quick Connect, a voucher, or pay below.`);
      return;
    }

    // Loop guard 2: enough auto-submit attempts in the last 60s indicates
    // the auth path is broken (RADIUS / walled-garden / MAC format issue).
    // Stop retrying and show the manual UI instead of trapping the customer.
    if (recentAutoAttempts() >= 3) {
      setAutoCheck('unknown');
      setError('Auto-login keeps failing. Try Quick Connect with your M-Pesa number, a voucher, or pay below.');
      return;
    }

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
      // Record BEFORE the form posts so the next captive load sees the count.
      recordAutoAttempt();
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

      // Compute fingerprint once; used for both token (Step 2) and
      // server-side fingerprint correlation (Step 3).
      const fp = await getFingerprint();

      // Step 2: device token (silent rebind for randomized MAC).
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored) {
        try {
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
        } catch {/* fall through to fingerprint path */}
      }

      // Step 3: fingerprint correlation (works even with localStorage cleared).
      // Server matches the browser fingerprint against device_tokens issued
      // on prior payments. Strict — only fires on unique fingerprint match.
      if (fp) {
        try {
          const fpRes = await api<{
            active: boolean; username?: string; password?: string;
            validitySeconds?: number; secondsRemaining?: number; rateLimit?: string | null;
            phone?: string | null; token?: string; reason?: string;
          }>('/hotspot/fingerprint-reconnect', {
            method: 'POST',
            body: JSON.stringify({ fingerprint: fp, mac: mtikParams.mac }),
          });
          if (fpRes.active && fpRes.username && fpRes.password) {
            if (fpRes.token) localStorage.setItem(TOKEN_KEY, fpRes.token);
            handleGrant(fpRes, 'Welcome back');
            return;
          }
        } catch {/* fall through to manual UI */}
      }

      // Step 4: nothing matched — show payment UI.
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
      const fp = await getFingerprint();
      const res = await api<{
        active: boolean; username: string; password: string;
        validitySeconds: number; rateLimit: string | null;
        token?: string;
      }>('/hotspot/rebind/verify', {
        method: 'POST',
        body: JSON.stringify({ otpId: rebind.otpId, code: rebind.code, fingerprint: fp || undefined }),
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
    // Learn which payment flow the ISP configured + where the money goes.
    api<{ collectionMethod: PayMethod; paybill?: string; till?: string; accountName?: string }>('/hotspot/pay-config')
      .then((c) => {
        setPayMethod(c.collectionMethod);
        setPayDest({ paybill: c.paybill ?? '', till: c.till ?? '', accountName: c.accountName ?? '' });
      })
      .catch(() => {/* default to STK */});
    // Rotating sponsor banners (revenue + ISP promos). Never blocks the portal.
    api<AdPublic[]>('/hotspot/ads?placement=portal_banner')
      .then(setAds)
      .catch(() => {/* no ads — portal is unaffected */});
    // Optional short sponsor clip shown after a successful payment.
    api<AdPublic[]>('/hotspot/ads?placement=post_payment')
      .then(setPostAds)
      .catch(() => {/* none — connect immediately */});
  };

  // Quick Connect: phone-based session lookup. Customer paid before from
  // any device; entering their M-Pesa number connects this device too,
  // copying the grant onto its MAC. SMS notification is sent to the phone
  // so the legitimate customer notices any misuse.
  const quickConnect = async () => {
    if (!phoneNormalized) {
      setError('Enter a valid Safaricom number first.');
      return;
    }
    if (!mtikParams?.mac) {
      setError('No device MAC detected. Make sure you opened this page from the captive Wi-Fi.');
      return;
    }
    setQuickBusy(true);
    setError(null);
    try {
      const r = await api<{
        active: boolean; username: string; password: string;
        validitySeconds: number; rateLimit: string | null;
      }>('/hotspot/quick-connect', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneNormalized, mac: mtikParams.mac }),
      });
      if (r.active) {
        window.localStorage.setItem(PHONE_KEY, phoneNormalized);
        setGrant({
          username: r.username,
          password: r.password,
          validitySeconds: r.validitySeconds,
          rateLimit: r.rateLimit,
          planName: 'Welcome back',
        });
        setTimeout(() => formRef.current?.submit(), 400);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setQuickBusy(false);
    }
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
      const endpoint =
        isInstrPay ? '/hotspot/pay-c2b' :
        payMethod === 'intasend' ? '/hotspot/pay-intasend' :
        payMethod === 'kopokopo' ? '/hotspot/pay-kopokopo' :
        '/hotspot/pay';
      const p = await api<PurchaseInit>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ plan_id: planId, phone: phoneNormalized, mac: mtikParams?.mac }),
      });
      window.localStorage.setItem(PHONE_KEY, phoneNormalized);
      setPurchase(p);
      setPurchaseStatus(
        isInstrPay
          ? (p.customerMessage ||
              `${payMethod === 'till' ? `Buy Goods Till ${payDest.till || p.payInstructions?.paybill}` : `Pay Bill ${payDest.paybill || p.payInstructions?.paybill}`} → Account ${p.payInstructions?.account} → KES ${p.amountKes}`)
          : (p.customerMessage || (p.simulated
              ? 'Simulation mode — confirming…'
              : 'STK push sent. Check your phone for the M-Pesa prompt.')));
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
    // Pre-compute fingerprint so the server can stamp it onto the
    // inline-minted token at first-success — enables fingerprint reconnect
    // for THIS browser on future visits even if localStorage is cleared.
    const fp = await getFingerprint();
    const start = performance.now();
    // C2B: customer leaves to pay the Paybill manually — give them longer.
    const deadline = start + (isInstrPay ? 240_000 : 90_000);
    const tick = async () => {
      try {
        const s = await api<{ status: string; grant?: GrantResult; failureReason?: string; token?: string }>(
          `/hotspot/pay/${p.checkoutRequestId}${fp ? `?fp=${encodeURIComponent(fp)}` : ''}`
        );
        setPollElapsed(Math.floor((performance.now() - start) / 1000));
        if (s.status === 'success' && s.grant) {
          setGrant(s.grant);
          setSubmitting(false);
          // Inline-minted token piggybacks on the success poll response.
          if ((s as any).token) localStorage.setItem(TOKEN_KEY, (s as any).token);
          // If the ISP configured a post-payment sponsor clip, show it first;
          // its overlay connects on end/skip. Otherwise connect immediately.
          if (postAds.length > 0) setShowPostAd(true);
          else setTimeout(() => formRef.current?.submit(), 400);
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

  // Dynamic per-state style for plan cards. Pulled out of `styles` so the
  // Record<string, CSSProperties> annotation below stays valid (functions
  // don't fit it). The old tabStyle was removed when the Voucher/Pay tabs
  // gave way to the Quick Connect / Voucher collapsible bars.
  const planCardStyle = (active: boolean): CSSProperties => ({
    background: active ? `rgba(${brandRgb},0.06)` : '#ffffff',
    border: active ? `2px solid ${brand.color}` : '1px solid #e2e8f0',
    borderRadius: 12,
    padding: active ? '13px 15px' : '14px 16px', // -1px to offset the thicker border
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    boxShadow: active ? `0 6px 16px rgba(${brandRgb},0.16)` : '0 1px 2px rgba(15,23,42,0.05)',
    transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease',
  });

  // CSS variables drive the theme — only the brand colour changes per tenant.
  // Light, minimal palette: white card on a soft tinted background.
  const look = templateLook(brand.template ?? 'classic', brand.color, brandRgb);
  const styles: Record<string, CSSProperties> = {
    page: {
      minHeight: '100vh',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
      background: look.pageBg,
      color: look.pageColor,
      fontFamily: "'Inter', system-ui, -apple-system, 'Plus Jakarta Sans', sans-serif",
    },
    card: {
      maxWidth: 440,
      width: '100%',
      background: look.cardBg,
      border: look.cardBorder,
      borderRadius: 18,
      padding: 'clamp(18px, 5vw, 28px)', // tighter on phones, roomy on desktop
      boxShadow: look.cardShadow,
    },
    wordmark: {
      fontSize: 28,
      fontWeight: 800,
      letterSpacing: '-0.02em',
      color: look.wordmark,
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
      borderRadius: 10,
      padding: 14,
      fontSize: 15,
      fontWeight: 700,
      cursor: 'pointer',
      marginTop: 16,
      boxShadow: `0 4px 14px rgba(${brandRgb},0.30)`,
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
    <div className="hs-portal" style={{ ...styles.page, ['--brand' as any]: brand.color }}>
      <style>{`
        .hs-portal input:focus, .hs-portal select:focus, .hs-portal textarea:focus {
          border-color: var(--brand) !important;
          box-shadow: 0 0 0 3px rgba(${brandRgb}, 0.16) !important;
        }
        .hs-portal button { transition: transform .07s ease, filter .15s ease, box-shadow .15s ease; }
        .hs-portal button:active:not(:disabled) { transform: translateY(1px); }
        .hs-portal button:disabled { opacity: .55; cursor: not-allowed; }
      `}</style>
      {showPostAd && postAd && (
        <PostPayAd
          ad={postAd}
          onDone={() => { setShowPostAd(false); setTimeout(() => formRef.current?.submit(), 150); }}
        />
      )}
      <div style={styles.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
          {brand.logoUrl && (
            <img
              src={brand.logoUrl}
              alt={brand.name}
              style={{ height: 56, width: 56, objectFit: 'contain', flexShrink: 0 }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 style={{ ...styles.wordmark, margin: 0 }}>{brand.name}</h1>
            <p style={{ ...styles.tagline, marginTop: 2, marginBottom: 0 }}>{brand.tagline}</p>
          </div>
        </div>
        <div style={{ height: 16 }} />

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

            {purchase ? (
              <>
                {purchase.payInstructions ? (
                  // C2B pay-bill: show the steps the customer types into M-Pesa.
                  <div style={styles.okToast}>
                    <strong>Pay with M-Pesa to connect:</strong>
                    {payMethod === 'till' ? (
                      <div style={{ marginTop: 8, lineHeight: 1.9 }}>
                        <div>1. Lipa na M-Pesa → <strong>Buy Goods and Services</strong></div>
                        <div>2. Till no: <strong style={{ fontSize: 18 }}>{payDest.till || purchase.payInstructions.paybill}</strong></div>
                        <div>3. Account / Ref: <strong style={{ fontSize: 18 }}>{purchase.payInstructions.account}</strong> (this exact reference)</div>
                        <div>4. Amount: <strong style={{ fontSize: 18 }}>KES {purchase.amountKes}</strong></div>
                      </div>
                    ) : (
                      <div style={{ marginTop: 8, lineHeight: 1.9 }}>
                        <div>1. Lipa na M-Pesa → <strong>Pay Bill</strong></div>
                        <div>2. Business no: <strong style={{ fontSize: 18 }}>{payDest.paybill || purchase.payInstructions.paybill}</strong></div>
                        <div>3. Account no: <strong style={{ fontSize: 18 }}>{purchase.payInstructions.account}</strong> (this exact reference)</div>
                        <div>4. Amount: <strong style={{ fontSize: 18 }}>KES {purchase.amountKes}</strong></div>
                      </div>
                    )}
                    <p style={{ ...styles.sub, marginTop: 8, marginBottom: 0 }}>
                      You'll connect automatically once payment is received — keep this page open.
                    </p>
                  </div>
                ) : (
                  <div style={styles.okToast}>
                    {purchaseStatus}
                    <br />
                    <small>{purchase.customerMessage}</small>
                  </div>
                )}
                <p style={{ ...styles.sub, textAlign: 'center', marginTop: 12 }}>
                  {purchase.payInstructions ? 'Waiting for your payment…' : 'Waiting for M-Pesa…'}{' '}
                  <strong>{pollElapsed}s</strong>
                </p>
                {pollElapsed >= 30 && (
                  <button onClick={resendStk} style={styles.btnGhost}>
                    {purchase.payInstructions ? 'Start over' : "Didn't receive prompt? Resend"}
                  </button>
                )}
              </>
            ) : (
              <>
                {/* Quick Connect — collapsible. Phone-based active-session lookup. */}
                <CollapsibleBar
                  open={expanded === 'quick'}
                  onToggle={() => setExpanded(expanded === 'quick' ? null : 'quick')}
                  brand={brand.color}
                  brandRgb={brandRgb}
                  label="Quick Connect"
                  hint="Paid before? Enter your M-Pesa number"
                >
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
                  <button
                    onClick={quickConnect}
                    disabled={!phoneValid || quickBusy}
                    style={{ ...styles.btnPrimary, opacity: !phoneValid || quickBusy ? 0.5 : 1 }}
                  >
                    {quickBusy ? 'Looking up…' : 'Connect'}
                  </button>
                </CollapsibleBar>

                {/* Voucher — collapsible. */}
                <CollapsibleBar
                  open={expanded === 'voucher'}
                  onToggle={() => setExpanded(expanded === 'voucher' ? null : 'voucher')}
                  brand={brand.color}
                  brandRgb={brandRgb}
                  label="Voucher"
                  hint="Have an SMS code? Enter it here"
                >
                  <input
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
                </CollapsibleBar>

                <AdBanner ads={ads} />

                {/* Plan cards. Selecting a card reveals the phone field + Pay button. */}
                <div style={{ marginTop: 20, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', letterSpacing: 0.4, textTransform: 'uppercase' }}>
                    Choose a package
                  </div>
                </div>
                {plansLoading ? (
                  <p style={styles.sub}>Loading plans…</p>
                ) : plansError ? (
                  <>
                    <div style={styles.errToast}>{plansError}</div>
                    <button onClick={loadPlans} style={styles.btnGhost}>Retry</button>
                  </>
                ) : plans.length === 0 ? (
                  <p style={styles.sub}>No hotspot plans configured yet. Ask staff to add packages from the dashboard.</p>
                ) : (
                  <>
                    {showCatTabs && (
                      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                        {(['All', ...presentCats] as const).map((c) => {
                          const on = planCat === c;
                          return (
                            <button key={c} onClick={() => setPlanCat(c)} style={{
                              fontFamily: 'inherit', cursor: 'pointer',
                              fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 999,
                              border: `1px solid ${on ? brand.color : '#e2e8f0'}`,
                              background: on ? `rgba(${brandRgb},0.10)` : '#ffffff',
                              color: on ? brand.color : '#475569',
                            }}>{c}</button>
                          );
                        })}
                      </div>
                    )}
                  <div style={{ display: 'grid', gap: 10 }}>
                    {visiblePlans.map((p) => {
                      const active = p.id === planId;
                      const down = formatSpeed(p.speed_down_kbps);
                      const chips = [formatDuration(p.validity_minutes, p.validity_days)];
                      if (down) chips.push(down);
                      chips.push(formatData(p.data_cap_mb));
                      return (
                        <button key={p.id} onClick={() => { setPlanId(p.id); setExpanded(null); }} style={planCardStyle(active)}>
                          <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                            <div style={{ fontWeight: 700, fontSize: 17, color: active ? brand.color : '#0f172a', lineHeight: 1.2 }}>
                              {p.name}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                              {chips.map((c, i) => (
                                <span key={i} style={{
                                  fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                                  color: active ? brand.color : '#475569',
                                  background: active ? `rgba(${brandRgb},0.12)` : '#f1f5f9',
                                  borderRadius: 999, padding: '3px 9px',
                                }}>{c}</span>
                              ))}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, letterSpacing: '0.05em' }}>KES</div>
                            <div style={{ fontWeight: 800, fontSize: 23, color: active ? brand.color : '#0f172a', lineHeight: 1 }}>
                              {(p.price_cents / 100).toFixed(0)}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  </>
                )}

                {/* Once a plan is selected, prompt for M-Pesa phone + Pay. */}
                {selectedPlan && plans.length > 0 && (
                  <div style={{ marginTop: 16, padding: 14, background: `rgba(${brandRgb},0.04)`, border: `1px solid rgba(${brandRgb},0.18)`, borderRadius: 10 }}>
                    <div style={{ fontSize: 13, color: '#475569', marginBottom: 8 }}>
                      Pay <strong style={{ color: brand.color }}>KES {(selectedPlan.price_cents / 100).toFixed(0)}</strong> for <strong>{selectedPlan.name}</strong> via M-Pesa
                    </div>
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
                    <button
                      onClick={payMpesa}
                      disabled={!phoneValid || submitting}
                      style={{ ...styles.btnPrimary, opacity: !phoneValid || submitting ? 0.5 : 1 }}
                    >
                      {submitting
                        ? (isInstrPay ? 'Getting pay details…' : 'Sending STK push…')
                        : (isInstrPay ? (payMethod === 'till' ? 'Show Till details' : 'Show Pay Bill details') : 'Pay & Connect')}
                    </button>
                  </div>
                )}
              </>
            )}

            {error && <div style={styles.errToast}>{error}</div>}
          </>
        )}

        <div style={styles.footer}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10,
            color: '#15803d', fontWeight: 600, fontSize: 12,
            background: 'rgba(22,163,74,0.08)', borderRadius: 999, padding: '4px 12px',
          }}>
            <span aria-hidden>🔒</span> Secure payment via M-Pesa
          </div>
          <div>
            Powered by {brand.name}
            {mtikParams?.mac && <> · <code style={styles.code}>{mtikParams.mac}</code></>}
          </div>
        </div>
      </div>
    </div>
  );
}
