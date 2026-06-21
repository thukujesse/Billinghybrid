'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

type CollectionMethod = 'stk' | 'paybill' | 'till' | 'bank' | 'intasend' | 'kopokopo';

// Every licensed Kenyan commercial bank. `paybill` is the bank's well-known
// M-Pesa "pay to your account" paybill (confirm with your bank — these are
// defaults). `direct` marks banks with their own STK API; all others collect
// via an aggregator (IntaSend/Kopo Kopo), which settles to ANY bank.
const KENYA_BANKS: { name: string; paybill?: string; direct?: 'equity_jenga' | 'kcb' }[] = [
  { name: 'Equity Bank', paybill: '247247', direct: 'equity_jenga' },
  { name: 'KCB Bank', paybill: '522522', direct: 'kcb' },
  { name: 'Co-operative Bank', paybill: '400200' },
  { name: 'NCBA Bank', paybill: '880100' },
  { name: 'Absa Bank Kenya', paybill: '303030' },
  { name: 'Standard Chartered', paybill: '329329' },
  { name: 'Diamond Trust Bank (DTB)', paybill: '516600' },
  { name: 'I&M Bank', paybill: '542542' },
  { name: 'Family Bank', paybill: '222111' },
  { name: 'National Bank (NBK)' },
  { name: 'Stanbic Bank' },
  { name: 'Prime Bank' },
  { name: 'HF Group (HFC)' },
  { name: 'Gulf African Bank' },
  { name: 'Sidian Bank' },
  { name: 'Ecobank Kenya' },
  { name: 'Bank of Africa' },
  { name: 'Credit Bank' },
  { name: 'Consolidated Bank' },
  { name: 'ABC Bank' },
  { name: 'Victoria Commercial Bank' },
  { name: 'Guaranty Trust Bank (GTBank)' },
  { name: 'Mayfair CIB Bank' },
  { name: 'Access Bank Kenya' },
  { name: 'UBA Kenya' },
  { name: 'SBM Bank Kenya' },
  { name: 'Dubai Islamic Bank' },
  { name: 'Premier Bank' },
  { name: 'Kingdom Bank' },
  { name: 'Bank of Baroda' },
  { name: 'Bank of India' },
  { name: 'Citibank Kenya' },
  { name: 'Other / not listed' },
];
interface MpesaPublic {
  env: 'sandbox' | 'production';
  shortcode: string;
  till: string;
  accountName: string;
  accountNo: string;
  bankProvider: string;
  bankProviderEnv: string;
  consumerKeySet: boolean;
  consumerSecretSet: boolean;
  passkeySet: boolean;
  simulated: boolean;
  collectionMethod: CollectionMethod;
}

interface KopokopoPublic {
  env: 'sandbox' | 'live';
  tillNumber: string;
  clientIdSet: boolean;
  clientSecretSet: boolean;
  apiKeySet: boolean;
  configured: boolean;
}

interface IntasendPublic {
  env: 'sandbox' | 'live';
  publicKeySet: boolean;
  secretKeySet: boolean;
  challengeSet: boolean;
  configured: boolean;
}

interface SmsPublic {
  provider: 'africastalking' | 'bytwave';
  africastalking: { username: string; senderId: string; apiKeySet: boolean };
  bytwave: { endpoint: string; senderId: string; payloadFormat: 'json' | 'form'; apiKeySet: boolean };
  simulated: boolean;
}

type HotspotTemplate = 'classic' | 'aurora' | 'minimal' | 'sunset';
interface HotspotBranding {
  name: string;
  color: string;
  tagline: string;
  logoUrl: string | null;
  template: HotspotTemplate;
}

const TEMPLATES: Array<{ id: HotspotTemplate; label: string; hint: string }> = [
  { id: 'classic', label: 'Classic', hint: 'Soft tint, white card' },
  { id: 'aurora', label: 'Aurora', hint: 'Bold brand gradient' },
  { id: 'minimal', label: 'Minimal', hint: 'Flat, clean, no gradient' },
  { id: 'sunset', label: 'Sunset', hint: 'Warm glass card' },
];

/** Mirror of the portal's per-template look (for the preview + picker swatches). */
function templateLook(template: HotspotTemplate, color: string, rgb: string) {
  switch (template) {
    case 'aurora': return { pageBg: `linear-gradient(160deg, ${color} 0%, rgba(${rgb},0.6) 50%, #0b1220 135%)`, cardBg: '#ffffff', cardBorder: 'none', cardShadow: '0 18px 44px rgba(0,0,0,0.35)', wordmark: color };
    case 'minimal': return { pageBg: '#f4f6f9', cardBg: '#ffffff', cardBorder: '1px solid #e5e9f0', cardShadow: 'none', wordmark: '#0f172a' };
    case 'sunset': return { pageBg: `linear-gradient(160deg, rgba(${rgb},0.20) 0%, #fff7ed 48%, #fef2f2 100%)`, cardBg: 'rgba(255,255,255,0.88)', cardBorder: '1px solid rgba(255,255,255,0.7)', cardShadow: '0 12px 34px rgba(15,23,42,0.13)', wordmark: color };
    default: return { pageBg: `linear-gradient(180deg, rgba(${rgb},0.05) 0%, #f8fafc 100%)`, cardBg: '#ffffff', cardBorder: '1px solid #e2e8f0', cardShadow: '0 10px 28px rgba(15,23,42,0.08)', wordmark: color };
  }
}

interface HotspotPlanLite {
  name: string;
  price_cents: number;
  validity_days: number;
  validity_minutes: number | null;
  speed_down_kbps: number | null;
}

function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return '37,99,235';
  return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
}
function durLabel(mins: number | null, days: number): string {
  const m = mins ?? days * 1440;
  if (m % 43200 === 0) return `${m / 43200} month${m / 43200 > 1 ? 's' : ''}`;
  if (m % 10080 === 0) return `${m / 10080} week${m / 10080 > 1 ? 's' : ''}`;
  if (m % 1440 === 0) return `${m / 1440} day${m / 1440 > 1 ? 's' : ''}`;
  if (m % 60 === 0) return `${m / 60} hour${m / 60 > 1 ? 's' : ''}`;
  return `${m} min`;
}
function speedLabel(kbps: number | null): string {
  if (!kbps) return '';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(0)} Mbps` : `${kbps} Kbps`;
}

const SANDBOX_PASSKEY =
  'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

type SettingsTab = 'payments' | 'sms' | 'hotspot';
const TAB_IDS: SettingsTab[] = ['payments', 'sms', 'hotspot'];
const TAB_LABELS: Record<SettingsTab, string> = {
  payments: 'Payments',
  sms: 'SMS / Notifications',
  hotspot: 'Hotspot portal',
};

export default function SettingsPage() {
  const [mpesa, setMpesa] = useState<MpesaPublic | null>(null);
  const [form, setForm] = useState({
    env: 'sandbox' as 'sandbox' | 'production',
    shortcode: '174379',
    till: '',
    accountName: '',
    accountNo: '',
    bankProvider: '',
    bankProviderEnv: 'sandbox',
    consumerKey: '',
    consumerSecret: '',
    passkey: '',
    collectionMethod: 'bank' as CollectionMethod,
  });
  const [bankName, setBankName] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tab, setTab] = useState<SettingsTab>('payments');
  const [mpesaTestPhone, setMpesaTestPhone] = useState('');
  const [mpesaTesting, setMpesaTesting] = useState(false);
  const [registeringC2b, setRegisteringC2b] = useState(false);

  // IntaSend aggregator config (env + keys + webhook challenge).
  const [intasend, setIntasend] = useState<IntasendPublic | null>(null);
  const [intaForm, setIntaForm] = useState({ env: 'sandbox' as 'sandbox' | 'live', publicKey: '', secretKey: '', challenge: '' });
  const [intaSaving, setIntaSaving] = useState(false);

  // Kopo Kopo aggregator config.
  const [kopo, setKopo] = useState<KopokopoPublic | null>(null);
  const [kopoForm, setKopoForm] = useState({ env: 'sandbox' as 'sandbox' | 'live', clientId: '', clientSecret: '', tillNumber: '', apiKey: '' });
  const [kopoSaving, setKopoSaving] = useState(false);

  // The single shared HubNet callback/IPN URLs (incl. token) to register at the bank/Safaricom.
  const [sharedUrls, setSharedUrls] = useState<{ confirmationUrl?: string; jengaUrl?: string }>({});

  // Hotspot template branding (logo, ISP name, tagline, brand color).
  // Drives the captive portal at billing.hubnetwifi.co.ke/hotspot.
  const [brand, setBrand] = useState<HotspotBranding | null>(null);
  const [brandForm, setBrandForm] = useState<HotspotBranding>({
    name: '', color: '#2563eb', tagline: '', logoUrl: null, template: 'classic',
  });
  const [brandSaving, setBrandSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  // The ISP's real hotspot packages, shown in the live portal preview.
  const [previewPlans, setPreviewPlans] = useState<HotspotPlanLite[]>([]);

  const load = () =>
    api<MpesaPublic>('/settings/mpesa')
      .then((m) => {
        setMpesa(m);
        setForm((f) => ({ ...f, env: m.env, shortcode: m.shortcode, till: m.till, accountName: m.accountName, accountNo: m.accountNo ?? '', bankProvider: m.bankProvider ?? '', bankProviderEnv: m.bankProviderEnv ?? 'sandbox', collectionMethod: m.collectionMethod }));
      })
      .catch((e: any) => setToast({ ok: false, msg: e.message }));

  const loadIntasend = () =>
    api<IntasendPublic>('/settings/intasend')
      .then((i) => { setIntasend(i); setIntaForm((f) => ({ ...f, env: i.env })); })
      .catch(() => {/* endpoint absent before deploy — ignore */});

  const loadKopo = () =>
    api<KopokopoPublic>('/settings/kopokopo')
      .then((k) => { setKopo(k); setKopoForm((f) => ({ ...f, env: k.env, tillNumber: k.tillNumber })); })
      .catch(() => {/* endpoint absent before deploy — ignore */});

  const saveKopo = async () => {
    setKopoSaving(true);
    try {
      const body: Record<string, unknown> = { env: kopoForm.env, tillNumber: kopoForm.tillNumber };
      if (kopoForm.clientId) body.clientId = kopoForm.clientId;
      if (kopoForm.clientSecret) body.clientSecret = kopoForm.clientSecret;
      if (kopoForm.apiKey) body.apiKey = kopoForm.apiKey;
      const k = await api<KopokopoPublic>('/settings/kopokopo', { method: 'PUT', body: JSON.stringify(body) });
      setKopo(k);
      setKopoForm((f) => ({ ...f, clientId: '', clientSecret: '', apiKey: '' }));
      setToast({ ok: true, msg: 'Kopo Kopo settings saved' });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setKopoSaving(false);
    }
  };

  const saveIntasend = async () => {
    setIntaSaving(true);
    try {
      const body: Record<string, unknown> = { env: intaForm.env };
      if (intaForm.publicKey) body.publicKey = intaForm.publicKey;
      if (intaForm.secretKey) body.secretKey = intaForm.secretKey;
      if (intaForm.challenge) body.challenge = intaForm.challenge;
      const i = await api<IntasendPublic>('/settings/intasend', { method: 'PUT', body: JSON.stringify(body) });
      setIntasend(i);
      setIntaForm((f) => ({ ...f, publicKey: '', secretKey: '', challenge: '' }));
      setToast({ ok: true, msg: 'IntaSend settings saved' });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setIntaSaving(false);
    }
  };

  const loadBrand = () =>
    api<HotspotBranding>('/admin/hotspot-branding')
      .then((b) => { setBrand(b); setBrandForm(b); })
      .catch((e: any) => setToast({ ok: false, msg: e.message }));

  // SMS provider settings — same shape as M-Pesa: public read returns
  // which-creds-are-set booleans, secrets are write-only.
  const [sms, setSms] = useState<SmsPublic | null>(null);
  const [smsForm, setSmsForm] = useState({
    provider: 'africastalking' as 'africastalking' | 'bytwave',
    atUsername: 'sandbox', atApiKey: '', atSenderId: '',
    bytwaveApiKey: '', bytwaveEndpoint: 'https://portal.bytewavenetworks.com/api/http/sms/send',
    bytwaveSenderId: '', bytwavePayloadFormat: 'json' as 'json' | 'form',
  });
  const [smsSaving, setSmsSaving] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [smsTestSending, setSmsTestSending] = useState(false);

  const loadSms = () =>
    api<SmsPublic>('/settings/sms')
      .then((s) => {
        setSms(s);
        setSmsForm((f) => ({
          ...f,
          provider: s.provider,
          atUsername: s.africastalking.username, atSenderId: s.africastalking.senderId,
          bytwaveEndpoint: s.bytwave.endpoint, bytwaveSenderId: s.bytwave.senderId,
          bytwavePayloadFormat: s.bytwave.payloadFormat,
        }));
      })
      .catch((e: any) => setToast({ ok: false, msg: e.message }));

  const saveSms = async () => {
    setSmsSaving(true);
    try {
      const body: Record<string, unknown> = { provider: smsForm.provider };
      const at: Record<string, string> = {
        username: smsForm.atUsername, senderId: smsForm.atSenderId,
      };
      if (smsForm.atApiKey) at.apiKey = smsForm.atApiKey;
      body.africastalking = at;
      const bw: Record<string, string> = {
        endpoint: smsForm.bytwaveEndpoint, senderId: smsForm.bytwaveSenderId,
        payloadFormat: smsForm.bytwavePayloadFormat,
      };
      if (smsForm.bytwaveApiKey) bw.apiKey = smsForm.bytwaveApiKey;
      body.bytwave = bw;
      const r = await api<SmsPublic>('/settings/sms', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setSms(r);
      setSmsForm((f) => ({ ...f, atApiKey: '', bytwaveApiKey: '' }));
      setToast({ ok: true, msg: 'SMS settings saved' });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setSmsSaving(false);
    }
  };

  const sendTestSms = async () => {
    if (!testPhone) return;
    setSmsTestSending(true);
    try {
      const r = await api<{
        ok: boolean; provider: string; sent_to: string; message: string;
        detail: string; simulated?: boolean;
      }>('/settings/sms/test', {
        method: 'POST',
        body: JSON.stringify({ phone: testPhone }),
      });
      // Surface the FULL provider response in the toast so the operator
      // doesn't have to dig through Render logs to see why a send failed.
      // For success: "via bytwave → sent · sent to 254..."
      // For sim:     "SIMULATED — no API key set for bytwave"
      // For fail:    "via bytwave → FAILED — bytwave error 401: invalid key"
      const prefix = r.simulated ? 'SIMULATED' : `via ${r.provider}`;
      const arrow  = r.ok ? '→ sent' : '→ FAILED';
      setToast({
        ok: r.ok,
        msg: `${prefix} ${arrow} · ${r.detail}${r.ok ? ` · sent to ${r.sent_to}` : ''}`,
      });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setSmsTestSending(false);
    }
  };

  const resetSms = async () => {
    if (!confirm('Wipe every saved SMS setting? The hardcoded defaults in the API will take over.')) return;
    try {
      const r = await api<{ ok: boolean; deleted_rows: number }>('/settings/sms/reset', { method: 'POST' });
      setToast({ ok: true, msg: `Reset — ${r.deleted_rows} row(s) deleted. Reload to see defaults.` });
      loadSms();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    }
  };

  // One-tap "show me what's actually in the DB" helper. Pulls /debug and
  // dumps to the toast so the operator can verify the saved key length
  // without re-typing the secret.
  const debugSms = async () => {
    try {
      const d = await api<{
        active_provider: string; active_provider_key_set: boolean;
        active_provider_key_length: number; will_simulate: boolean;
        africastalking: { username: string; sender_id: string; api_key_set: boolean; api_key_length: number };
        bytwave: { endpoint: string; sender_id: string; payload_format: string; api_key_set: boolean; api_key_length: number };
      }>('/settings/sms/debug');
      const lines = [
        `Active: ${d.active_provider} (will ${d.will_simulate ? 'SIMULATE' : 'send'})`,
        `AT key: ${d.africastalking.api_key_set ? `set (${d.africastalking.api_key_length} chars)` : 'NOT SET'} · sender: ${d.africastalking.sender_id || '—'}`,
        `Bytwave key: ${d.bytwave.api_key_set ? `set (${d.bytwave.api_key_length} chars)` : 'NOT SET'} · ${d.bytwave.endpoint} · sender: ${d.bytwave.sender_id || '—'}`,
      ];
      setToast({ ok: !d.will_simulate, msg: lines.join(' · ') });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    }
  };

  useEffect(() => {
    load(); loadBrand(); loadSms(); loadIntasend(); loadKopo();
    api<{ confirmationUrl?: string; jengaUrl?: string }>('/payments/shared-callback-info').then(setSharedUrls).catch(() => {/* before deploy */});
    if (typeof window !== 'undefined' && window.location.hash === '#sms') setTab('sms');
    api<HotspotPlanLite[]>('/hotspot/plans').then(setPreviewPlans).catch(() => {/* preview falls back to samples */});
  }, []);

  const saveBrand = async () => {
    setBrandSaving(true);
    try {
      const updated = await api<HotspotBranding>('/admin/hotspot-branding', {
        method: 'PUT',
        body: JSON.stringify({
          name: brandForm.name,
          color: brandForm.color,
          tagline: brandForm.tagline,
          logoUrl: brandForm.logoUrl,
          template: brandForm.template,
        }),
      });
      setBrand(updated);
      setBrandForm(updated);
      setToast({ ok: true, msg: 'Hotspot template saved' });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBrandSaving(false);
    }
  };

  // Convert the chosen file to a data: URL so we can persist without an
  // external object store. Browser-side resize keeps the payload small.
  const onLogoFile = (file: File | null) => {
    if (!file) return;
    if (file.size > 500_000) {
      setToast({ ok: false, msg: 'Logo too big — pick something under 500 KB before resize.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Resize to max 256px on the long edge — captive portal renders ~80px,
        // so 256 covers retina without bloating the DB.
        const maxEdge = 256;
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL(file.type.includes('png') ? 'image/png' : 'image/jpeg', 0.85);
        setBrandForm((b) => ({ ...b, logoUrl: dataUrl }));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const clearLogo = () => {
    setBrandForm((b) => ({ ...b, logoUrl: null }));
    if (logoInputRef.current) logoInputRef.current.value = '';
  };

  // methodOverride lets the simple Bank form save as bank without the ISP ever
  // touching the method picker (the backend does the rest automatically).
  const save = async (methodOverride?: CollectionMethod) => {
    setSaving(true);
    const method = methodOverride ?? form.collectionMethod;
    try {
      const body: Record<string, unknown> = {
        env: form.env,
        shortcode: form.shortcode,
        till: form.till,
        accountName: form.accountName,
        accountNo: form.accountNo,
        bankProvider: form.bankProvider,
        bankProviderEnv: form.bankProviderEnv,
        collectionMethod: method,
      };
      // Only send secret fields if non-empty — empty means "leave as-is".
      if (form.consumerKey) body.consumerKey = form.consumerKey;
      if (form.consumerSecret) body.consumerSecret = form.consumerSecret;
      if (form.passkey) body.passkey = form.passkey;
      const m = await api<MpesaPublic>('/settings/mpesa', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setMpesa(m);
      setForm({ ...form, collectionMethod: method, consumerKey: '', consumerSecret: '', passkey: '' });
      setToast({ ok: true, msg: 'Payment settings saved' });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  // Unified "How customers pay" selector — one choice that drives both the
  // collection method and (for banks) the STK provider.
  const payMode =
    form.collectionMethod === 'stk' ? 'stk'
    : form.collectionMethod === 'intasend' ? 'intasend'
    : form.collectionMethod === 'kopokopo' ? 'kopokopo'
    : form.bankProvider === 'equity_jenga' ? 'equity_jenga'
    : form.bankProvider === 'kcb' ? 'kcb'
    : 'manual';
  const setPayMode = (v: string) => {
    if (v === 'stk') setForm({ ...form, collectionMethod: 'stk', bankProvider: '' });
    else if (v === 'intasend') setForm({ ...form, collectionMethod: 'intasend', bankProvider: '' });
    else if (v === 'kopokopo') setForm({ ...form, collectionMethod: 'kopokopo', bankProvider: '' });
    else if (v === 'equity_jenga') setForm({ ...form, collectionMethod: 'bank', bankProvider: 'equity_jenga' });
    else if (v === 'kcb') setForm({ ...form, collectionMethod: 'bank', bankProvider: 'kcb' });
    else setForm({ ...form, collectionMethod: 'bank', bankProvider: '' });
  };
  // Which fields each method actually needs — so we only ever ask for those:
  //  bank rail  → shared paybill + account number (the routing key)
  //  own Daraja → own paybill + Daraja keys (bank is linked at Safaricom, no acct no.)
  //  aggregator → just the aggregator keys (payout bank is set in their dashboard)
  const isBankRail = payMode === 'manual' || payMode === 'equity_jenga' || payMode === 'kcb';
  const isOwnDaraja = payMode === 'stk';

  // Pick your bank: auto-fill its paybill and route to the right rail —
  // direct STK if the bank has an API, otherwise drop any direct provider so
  // the ISP uses an aggregator (which settles to that bank) or manual.
  const pickedBank = KENYA_BANKS.find((b) => b.name === bankName);
  const onPickBank = (name: string) => {
    setBankName(name);
    const b = KENYA_BANKS.find((x) => x.name === name);
    if (!b) return;
    setForm((f) => {
      if (b.direct) return { ...f, shortcode: b.paybill ?? f.shortcode, collectionMethod: 'bank', bankProvider: b.direct };
      const keepAgg = f.collectionMethod === 'intasend' || f.collectionMethod === 'kopokopo';
      return { ...f, shortcode: b.paybill ?? f.shortcode, collectionMethod: keepAgg ? f.collectionMethod : 'bank', bankProvider: '' };
    });
  };

  const sendTestStk = async () => {
    if (!mpesaTestPhone) return;
    setMpesaTesting(true);
    try {
      const r = await api<{ ok: boolean; checkoutRequestId?: string; customerMessage?: string; error?: string }>(
        '/settings/mpesa/test',
        { method: 'POST', body: JSON.stringify({ phone: mpesaTestPhone }) }
      );
      setToast({
        ok: r.ok,
        msg: r.ok
          ? `STK sent — check ${mpesaTestPhone} for the prompt (${r.checkoutRequestId})`
          : `STK failed: ${r.error}`,
      });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setMpesaTesting(false);
    }
  };

  const registerC2bUrls = async () => {
    setRegisteringC2b(true);
    try {
      const r = await api<{ ResponseDescription?: string; errorMessage?: string }>(
        '/settings/mpesa/register-c2b',
        { method: 'POST' }
      );
      const ok = !r.errorMessage;
      setToast({
        ok,
        msg: ok
          ? `C2B URLs registered with Safaricom ✓ ${r.ResponseDescription ?? ''}`
          : `Register failed: ${r.errorMessage}`,
      });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setRegisteringC2b(false);
    }
  };

  const usePresetSandbox = () => {
    setForm({
      ...form,
      env: 'sandbox',
      shortcode: '174379',
      passkey: SANDBOX_PASSKEY,
    });
    setToast({ ok: true, msg: 'Sandbox passkey + shortcode pre-filled. Add your own Consumer Key & Secret.' });
  };

  return (
    <div className="container">
      <h1>Settings</h1>
      <p className="sub">Runtime configuration. Secrets are write-only — once saved, they're not displayed again.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', margin: '10px 0 22px', flexWrap: 'wrap' }}>
        {TAB_IDS.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
              padding: '9px 16px', marginBottom: -1,
              borderBottom: tab === id ? '2px solid #2563eb' : '2px solid transparent',
              color: tab === id ? 'var(--text)' : 'var(--muted)',
              fontWeight: tab === id ? 700 : 500,
            }}
          >{TAB_LABELS[id]}</button>
        ))}
      </div>

      {tab === 'payments' && (<>
      <h2>How customers pay you</h2>
      {mpesa && (mpesa.collectionMethod === 'bank' ? (
        <div className={`toast ${mpesa.accountNo ? 'ok' : 'err'}`} style={{ marginBottom: 12 }}>
          {!mpesa.accountNo
            ? 'Almost there — enter your bank paybill and account number below to start collecting.'
            : mpesa.bankProvider
              ? `Automated — ${mpesa.bankProvider === 'kcb' ? 'KCB' : 'Equity'} sends the customer an STK prompt and deposits straight into your account ${mpesa.accountNo}.`
              : `Ready — customers pay paybill ${mpesa.shortcode || '(set your paybill)'} to account ${mpesa.accountNo}; each payment is verified and connects them automatically.`}
        </div>
      ) : (
        <div className={`toast ${mpesa.simulated ? 'err' : 'ok'}`} style={{ marginBottom: 12 }}>
          Status:{' '}
          {mpesa.simulated
            ? 'SIMULATION (missing one or more credentials — STK pushes won\'t go to Safaricom)'
            : `LIVE (${mpesa.env} · shortcode ${mpesa.shortcode})`}
        </div>
      ))}

      {/* Simple, primary form — bank details + (optional) the bank's own STK.
          Manual: the customer pays the paybill by hand. Automated STK (Equity /
          KCB): the BANK fires the prompt and deposits straight into the ISP's
          account — HubNet is never in the money path; it only needs the bank's
          merchant API keys. */}
      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          Choose how customers pay you — we only ask for what that method needs. Every payment is verified and connects the customer automatically.
        </p>
        {/* Bank picker only applies to the shared-paybill / bank-STK rails. */}
        {isBankRail && (
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Your bank</label>
              <select value={bankName} onChange={(e) => onPickBank(e.target.value)}>
                <option value="">Select your bank…</option>
                {KENYA_BANKS.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}{b.direct ? ' — direct STK' : ''}</option>
                ))}
              </select>
              {pickedBank && !pickedBank.direct && (
                <p className="sub" style={{ marginTop: 4, fontSize: 12 }}>
                  {pickedBank.name} doesn&apos;t expose its own STK API — pick <strong>IntaSend</strong> or <strong>Kopo Kopo</strong> below for an automated prompt (settles straight to your {pickedBank.name} account), or leave it Manual.
                </p>
              )}
            </div>
          </div>
        )}
        <div className="row">
          {(isBankRail || isOwnDaraja) && (
            <div style={{ flex: 1 }}>
              <label>{isOwnDaraja ? 'Your M-Pesa paybill / shortcode' : 'Bank paybill'}</label>
              <input value={form.shortcode} onChange={(e) => setForm({ ...form, shortcode: e.target.value })} placeholder={isOwnDaraja ? 'e.g. 174379 — your own paybill' : 'e.g. Equity 247247, KCB 522522'} />
            </div>
          )}
          <div style={{ flex: 1 }}>
            <label>How customers pay</label>
            <select value={payMode} onChange={(e) => setPayMode(e.target.value)}>
              <option value="manual">Manual — they pay the paybill by hand (no prompt)</option>
              <option value="stk">Automated STK — your own M-Pesa paybill (Daraja)</option>
              <option value="equity_jenga">Automated STK — Equity (JengaHQ) → your account</option>
              <option value="kcb">Automated STK — KCB (Buni) → your account</option>
              <option value="intasend">Automated STK — IntaSend (any bank) → your account</option>
              <option value="kopokopo">Automated STK — Kopo Kopo (any bank) → your till/bank</option>
            </select>
          </div>
        </div>
        {/* Account number is the routing key for the bank rails only. */}
        {isBankRail && (
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Account number</label>
              <input value={form.accountNo} onChange={(e) => setForm({ ...form, accountNo: e.target.value })} placeholder="your account no. — identifies you" />
            </div>
            <div style={{ flex: 1 }}>
              <label>Account name (optional)</label>
              <input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} placeholder="Name on the bank account" />
            </div>
          </div>
        )}

        {/* Own Safaricom paybill + Daraja keys. Money lands in YOUR paybill and
            Safaricom sweeps it to the bank you linked in the Safaricom portal —
            no account number needed here. */}
        {isOwnDaraja && (
          <div style={{ marginTop: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
            <p className="sub" style={{ marginTop: 0 }}>
              The prompt fires from <strong>your own</strong> paybill; Safaricom settles it to the bank account you linked in the Safaricom Business portal — HubNet never touches the money. Paste your Daraja keys from <a href="https://developer.safaricom.co.ke" target="_blank" rel="noreferrer">developer.safaricom.co.ke</a>. Runs in simulation until they&apos;re set.
            </p>
            <div style={{ maxWidth: 180, marginBottom: 8 }}>
              <label>Environment</label>
              <select value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value as any })}>
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </div>
            <label>Consumer Key {mpesa?.consumerKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={form.consumerKey} placeholder={mpesa?.consumerKeySet ? '••• leave empty to keep current' : 'from developer.safaricom.co.ke'} onChange={(e) => setForm({ ...form, consumerKey: e.target.value })} />
            <label>Consumer Secret {mpesa?.consumerSecretSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={form.consumerSecret} placeholder={mpesa?.consumerSecretSet ? '••• leave empty to keep current' : 'from developer.safaricom.co.ke'} onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })} />
            <label>Passkey {mpesa?.passkeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={form.passkey} placeholder={mpesa?.passkeySet ? '••• leave empty to keep current' : 'Lipa na M-Pesa Online passkey'} onChange={(e) => setForm({ ...form, passkey: e.target.value })} />
          </div>
        )}

        {/* Equity / KCB direct bank STK — money straight to the account above. */}
        {form.collectionMethod === 'bank' && form.bankProvider && (
          <div style={{ marginTop: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
            <p className="sub" style={{ marginTop: 0 }}>
              The <strong>{form.bankProvider === 'kcb' ? 'KCB' : 'Equity'}</strong> STK prompts the customer and deposits <strong>straight into your account above</strong> — HubNet never touches the money. Paste the merchant API keys from your {form.bankProvider === 'kcb' ? 'KCB Buni' : 'Equity JengaHQ'} portal. Runs in simulation until they&apos;re set.
            </p>
            <div style={{ maxWidth: 180, marginBottom: 8 }}>
              <label>Environment</label>
              <select value={form.bankProviderEnv} onChange={(e) => setForm({ ...form, bankProviderEnv: e.target.value })}>
                <option value="sandbox">Sandbox</option>
                <option value="live">Live</option>
              </select>
            </div>
            <BankStkProviders onToast={setToast} only={form.bankProvider} />
          </div>
        )}

        {/* IntaSend aggregator — STK to ANY bank, settles straight to the ISP's bank. */}
        {form.collectionMethod === 'intasend' && (
          <div style={{ marginTop: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
            <p className="sub" style={{ marginTop: 0 }}>
              IntaSend fires the STK and settles <strong>directly to your bank account — any bank</strong> (set the payout bank in your IntaSend dashboard). HubNet never touches the money. Sign up at <a href="https://intasend.com" target="_blank" rel="noreferrer">intasend.com</a> → API keys, and register your webhook URL there as <code>https://&lt;your-subdomain&gt;/api/payments/intasend/webhook</code>.
            </p>
            <div style={{ maxWidth: 180, marginBottom: 8 }}>
              <label>Environment</label>
              <select value={intaForm.env} onChange={(e) => setIntaForm({ ...intaForm, env: e.target.value as 'sandbox' | 'live' })}>
                <option value="sandbox">Sandbox (test)</option>
                <option value="live">Live</option>
              </select>
            </div>
            <label>Publishable key {intasend?.publicKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input value={intaForm.publicKey} onChange={(e) => setIntaForm({ ...intaForm, publicKey: e.target.value })}
              placeholder={intasend?.publicKeySet ? '••• leave empty to keep current' : 'ISPubKey_...'} />
            <label>Secret key {intasend?.secretKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={intaForm.secretKey} onChange={(e) => setIntaForm({ ...intaForm, secretKey: e.target.value })}
              placeholder={intasend?.secretKeySet ? '••• leave empty to keep current' : 'ISSecretKey_...'} />
            <label>Webhook challenge {intasend?.challengeSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={intaForm.challenge} onChange={(e) => setIntaForm({ ...intaForm, challenge: e.target.value })}
              placeholder={intasend?.challengeSet ? '••• leave empty to keep current' : 'a secret you also set in IntaSend'} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={saveIntasend} disabled={intaSaving}>{intaSaving ? 'Saving…' : 'Save IntaSend keys'}</button>
            </div>
          </div>
        )}

        {/* Kopo Kopo aggregator — STK to ANY bank/till. */}
        {form.collectionMethod === 'kopokopo' && (
          <div style={{ marginTop: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
            <p className="sub" style={{ marginTop: 0 }}>
              Kopo Kopo fires the STK and settles <strong>directly to your till / bank</strong>. HubNet never touches the money. Sign up at <a href="https://kopokopo.com" target="_blank" rel="noreferrer">kopokopo.com</a> → API keys (Client ID + Secret) + your Till. The callback is wired to your subdomain automatically.
            </p>
            <div className="row">
              <div style={{ flex: '0 0 160px' }}>
                <label>Environment</label>
                <select value={kopoForm.env} onChange={(e) => setKopoForm({ ...kopoForm, env: e.target.value as 'sandbox' | 'live' })}>
                  <option value="sandbox">Sandbox (test)</option>
                  <option value="live">Live</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label>Till number</label>
                <input value={kopoForm.tillNumber} onChange={(e) => setKopoForm({ ...kopoForm, tillNumber: e.target.value })} placeholder="your K2 till / store" />
              </div>
            </div>
            <label>Client ID {kopo?.clientIdSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={kopoForm.clientId} onChange={(e) => setKopoForm({ ...kopoForm, clientId: e.target.value })}
              placeholder={kopo?.clientIdSet ? '••• leave empty to keep current' : 'from the K2 dashboard'} />
            <label>Client Secret {kopo?.clientSecretSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={kopoForm.clientSecret} onChange={(e) => setKopoForm({ ...kopoForm, clientSecret: e.target.value })}
              placeholder={kopo?.clientSecretSet ? '••• leave empty to keep current' : 'from the K2 dashboard'} />
            <label>API key (webhook secret) {kopo?.apiKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={kopoForm.apiKey} onChange={(e) => setKopoForm({ ...kopoForm, apiKey: e.target.value })}
              placeholder={kopo?.apiKeySet ? '••• leave empty to keep current' : 'optional — for webhook signature'} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={saveKopo} disabled={kopoSaving}>{kopoSaving ? 'Saving…' : 'Save Kopo Kopo keys'}</button>
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <button onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <span className="sub" style={{ marginLeft: 12, fontSize: 12 }}>
            {payMode === 'manual' ? 'Customers will pay the paybill manually.'
              : payMode === 'stk' ? 'Your Daraja keys save together with this button.'
              : 'Save the keys above first, then Save here.'}
          </span>
        </div>
      </div>

      {/* Advanced — automated gateways (STK / aggregators / bank STK). Opt-in. */}
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '6px 0' }}>
          Advanced — automated gateways (STK Push, IntaSend, Kopo Kopo, bank STK) · optional
        </summary>

      <div className="card" style={{ marginTop: 8 }}>
        <div className="row">
          <div>
            <label>Environment</label>
            <select
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value as any })}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          </div>
          <div>
            {form.collectionMethod === 'till' ? (
              <>
                <label>Till number (Buy Goods)</label>
                <input value={form.till} onChange={(e) => setForm({ ...form, till: e.target.value })} placeholder="e.g. 5200000" />
              </>
            ) : (
              <>
                <label>{form.collectionMethod === 'bank' ? 'Bank Paybill (shared)' : 'Paybill / Shortcode'}</label>
                <input value={form.shortcode} onChange={(e) => setForm({ ...form, shortcode: e.target.value })} placeholder={form.collectionMethod === 'bank' ? 'e.g. Equity 247247, KCB 522522' : 'e.g. 174379'} />
                {form.collectionMethod === 'bank' && (
                  <p className="sub" style={{ marginTop: 4, fontSize: 12 }}>Your bank&apos;s shared M-Pesa paybill — many ISPs use the same one; your account number below is what identifies you.</p>
                )}
              </>
            )}
          </div>
        </div>

        {form.collectionMethod === 'bank' && (
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Bank account number</label>
              <input value={form.accountNo} onChange={(e) => setForm({ ...form, accountNo: e.target.value })} placeholder="Your bank account no. (customers type this as the M-Pesa account)" />
              <p className="sub" style={{ marginTop: 4, fontSize: 12 }}>This is your unique routing key — the bank&apos;s IPN uses it to credit the right ISP. Required.</p>
            </div>
            <div style={{ flex: 1 }}>
              <label>Bank account name</label>
              <input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} placeholder="Name on the bank account" />
            </div>
          </div>
        )}

        {form.collectionMethod === 'bank' && (
          <div className="row" style={{ marginTop: 4 }}>
            <div style={{ flex: 1 }}>
              <label>Collection mode</label>
              <select value={form.bankProvider} onChange={(e) => setForm({ ...form, bankProvider: e.target.value })}>
                <option value="">Manual — customer pays the paybill by hand (no STK)</option>
                <option value="equity_jenga">Automated STK — Equity (JengaHQ)</option>
                <option value="kcb">Automated STK — KCB</option>
              </select>
              <p className="sub" style={{ marginTop: 4, fontSize: 12 }}>
                Automated fires the bank&apos;s STK prompt — the customer just enters their PIN and the bank deposits to this account.
                Needs the bank&apos;s merchant API keys (panel appears below). No bank API? Use IntaSend / Kopo Kopo instead.
              </p>
            </div>
            {form.bankProvider && (
              <div style={{ flex: '0 0 150px' }}>
                <label>Environment</label>
                <select value={form.bankProviderEnv} onChange={(e) => setForm({ ...form, bankProviderEnv: e.target.value })}>
                  <option value="sandbox">Sandbox</option>
                  <option value="live">Live</option>
                </select>
              </div>
            )}
          </div>
        )}

        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Collection method</label>
            <select
              value={form.collectionMethod}
              onChange={(e) => setForm({ ...form, collectionMethod: e.target.value as CollectionMethod })}
            >
              <option value="stk">STK Push — prompt on customer&apos;s phone (your own Daraja API)</option>
              <option value="paybill">Paybill (no API) — customer pays your Paybill, account = reference</option>
              <option value="till">Till / Buy Goods (no API) — customer pays your Till, account = reference</option>
              <option value="bank">Bank — your bank Paybill + account name (verified via IPN)</option>
              <option value="intasend">IntaSend aggregator — M-Pesa STK, settles to your bank</option>
              <option value="kopokopo">Kopo Kopo aggregator — M-Pesa STK, settles to your bank/till</option>
            </select>
            <p className="sub" style={{ marginTop: 4 }}>
              {{
                stk: 'Portal sends an STK push to the customer\'s phone. Money lands in your own Paybill. Needs your Daraja Consumer Key/Secret + Passkey.',
                paybill: 'Money goes directly to YOUR Paybill. The portal shows the customer a reference to enter as the M-Pesa account; HubNet\'s callback verifies the payment and auto-connects them. Point your Paybill\'s C2B callback at the URL below.',
                till: 'Money goes directly to YOUR Till (Buy Goods). The portal shows a reference to enter as the account; HubNet\'s callback verifies and auto-connects. Point your Till\'s callback at the URL below.',
                bank: 'Money goes directly to your bank Paybill. Set your bank/Jenga IPN to the URL below; HubNet verifies each payment by reference and auto-connects the customer.',
                intasend: 'Portal triggers an M-Pesa STK via IntaSend (no Safaricom paybill of your own). IntaSend\'s webhook auto-activates the customer and settles funds to your bank. Add your IntaSend keys below.',
                kopokopo: 'Portal triggers an M-Pesa STK via Kopo Kopo. K2\'s webhook auto-activates the customer and settles funds to your till/bank. Add your Kopo Kopo keys below.',
              }[form.collectionMethod]}
            </p>
          </div>
        </div>

        {false /* moved to the simple form above */ && form.collectionMethod === 'stk' && (
          <>
            <label>Consumer Key {mpesa?.consumerKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input
              type="password"
              value={form.consumerKey}
              placeholder={mpesa?.consumerKeySet ? '••• leave empty to keep current' : 'paste from developer.safaricom.co.ke'}
              onChange={(e) => setForm({ ...form, consumerKey: e.target.value })}
            />

            <label>Consumer Secret {mpesa?.consumerSecretSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input
              type="password"
              value={form.consumerSecret}
              placeholder={mpesa?.consumerSecretSet ? '••• leave empty to keep current' : 'paste from developer.safaricom.co.ke'}
              onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })}
            />

            <label>Passkey {mpesa?.passkeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input
              type="password"
              value={form.passkey}
              placeholder={mpesa?.passkeySet ? '••• leave empty to keep current' : 'long hex string'}
              onChange={(e) => setForm({ ...form, passkey: e.target.value })}
            />
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={() => save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {form.collectionMethod === 'stk' && (
            <button className="ghost" onClick={usePresetSandbox} disabled={saving}>
              Pre-fill sandbox passkey
            </button>
          )}
        </div>

        {(form.collectionMethod === 'paybill' || form.collectionMethod === 'till' || form.collectionMethod === 'bank') && (
          <div style={{ marginTop: 20, borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>Point your {form.collectionMethod === 'till' ? 'Till' : form.collectionMethod === 'bank' ? 'bank' : 'Paybill'} callback here</h3>
            <p className="sub" style={{ marginTop: 0 }}>
              Money goes <strong>directly to your {form.collectionMethod === 'till' ? `Till ${form.till || ''}` : form.collectionMethod === 'bank' ? `bank account ${form.accountNo || ''}` : `Paybill ${form.shortcode || ''}`}</strong>. For HubNet to verify each
              payment and auto-connect the customer, point this {form.collectionMethod === 'bank' ? 'bank/Jenga IPN' : 'C2B callback'} URL at HubNet once — it&apos;s the
              <strong> same URL for everyone</strong>; we match the payment to you by the {form.collectionMethod === 'till' ? 'Till' : form.collectionMethod === 'bank' ? 'bank account number' : 'Paybill number'} above:
            </p>
            <code style={{ display: 'block', padding: '8px 10px', background: 'var(--surface,#f4f6f9)', borderRadius: 6, fontSize: 12, wordBreak: 'break-all' }}>
              {form.collectionMethod === 'bank'
                ? (sharedUrls.jengaUrl ?? 'https://pay.hubnetwifi.co.ke/api/payments/shared/jenga/ipn')
                : (sharedUrls.confirmationUrl ?? 'https://pay.hubnetwifi.co.ke/api/payments/shared/confirmation')}
            </code>
            {form.collectionMethod !== 'bank' && (
              <>
                <p className="sub" style={{ marginTop: 10 }}>
                  If your Paybill has Daraja API access, save your Consumer Key/Secret above and register the URLs automatically:
                </p>
                <button className="ghost" onClick={registerC2bUrls} disabled={registeringC2b || saving}>
                  {registeringC2b ? 'Registering…' : 'Auto-register C2B URLs'}
                </button>
              </>
            )}
            <p className="sub" style={{ marginTop: 10 }}>
              {form.collectionMethod === 'bank'
                ? <>Customers pay <strong>Paybill {form.shortcode || '247247'}</strong> → account <strong>{form.accountNo || 'your bank account no.'}</strong>. HubNet matches each payment to the customer by their phone&nbsp;+ amount and auto-connects them.</>
                : <>Customers see a short reference (e.g. <strong>HUB123456</strong>) to enter as the M-Pesa <em>account number</em> when paying — that&apos;s how the payment is matched to them.</>}
            </p>
          </div>
        )}

        {false /* moved to the simple form above */ && form.collectionMethod === 'intasend' && (
          <div style={{ marginTop: 20, borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>
              IntaSend setup {intasend?.configured && <span style={{ color: 'var(--green)' }}>✓ configured</span>}
            </h3>
            <p className="sub" style={{ marginTop: 0 }}>
              Sign up at intasend.com → API keys. Paste your <strong>Secret key</strong> (and Publishable key),
              pick the environment, and set a <strong>webhook challenge</strong> (any secret string) here AND in the
              IntaSend dashboard. Register your webhook URL there as:
              <br />
              <code>https://demo.hubnetwifi.co.ke/api/payments/intasend/webhook</code>
            </p>
            <div className="row">
              <div style={{ flex: '0 0 160px' }}>
                <label>Environment</label>
                <select value={intaForm.env} onChange={(e) => setIntaForm({ ...intaForm, env: e.target.value as 'sandbox' | 'live' })}>
                  <option value="sandbox">Sandbox (test)</option>
                  <option value="live">Live</option>
                </select>
              </div>
            </div>
            <label>Publishable key {intasend?.publicKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input value={intaForm.publicKey} onChange={(e) => setIntaForm({ ...intaForm, publicKey: e.target.value })}
              placeholder={intasend?.publicKeySet ? '••• leave empty to keep current' : 'ISPubKey_...'} />
            <label>Secret key {intasend?.secretKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={intaForm.secretKey} onChange={(e) => setIntaForm({ ...intaForm, secretKey: e.target.value })}
              placeholder={intasend?.secretKeySet ? '••• leave empty to keep current' : 'ISSecretKey_...'} />
            <label>Webhook challenge {intasend?.challengeSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={intaForm.challenge} onChange={(e) => setIntaForm({ ...intaForm, challenge: e.target.value })}
              placeholder={intasend?.challengeSet ? '••• leave empty to keep current' : 'a secret you also set in IntaSend'} />
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={saveIntasend} disabled={intaSaving}>{intaSaving ? 'Saving…' : 'Save IntaSend'}</button>
            </div>
          </div>
        )}

        {false /* moved to the simple form above */ && form.collectionMethod === 'kopokopo' && (
          <div style={{ marginTop: 20, borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>
              Kopo Kopo setup {kopo?.configured && <span style={{ color: 'var(--green)' }}>✓ configured</span>}
            </h3>
            <p className="sub" style={{ marginTop: 0 }}>
              Sign up at kopokopo.com → API keys (Client ID + Secret) and your Till number. The portal triggers an
              M-Pesa STK via Kopo Kopo; their webhook auto-activates the customer and settles funds to your till/bank.
              The callback is wired automatically to your own subdomain.
            </p>
            <div className="row">
              <div style={{ flex: '0 0 160px' }}>
                <label>Environment</label>
                <select value={kopoForm.env} onChange={(e) => setKopoForm({ ...kopoForm, env: e.target.value as 'sandbox' | 'live' })}>
                  <option value="sandbox">Sandbox (test)</option>
                  <option value="live">Live</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label>Till number</label>
                <input value={kopoForm.tillNumber} onChange={(e) => setKopoForm({ ...kopoForm, tillNumber: e.target.value })}
                  placeholder="your K2 till / store" />
              </div>
            </div>
            <label>Client ID {kopo?.clientIdSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={kopoForm.clientId} onChange={(e) => setKopoForm({ ...kopoForm, clientId: e.target.value })}
              placeholder={kopo?.clientIdSet ? '••• leave empty to keep current' : 'from the K2 dashboard'} />
            <label>Client Secret {kopo?.clientSecretSet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={kopoForm.clientSecret} onChange={(e) => setKopoForm({ ...kopoForm, clientSecret: e.target.value })}
              placeholder={kopo?.clientSecretSet ? '••• leave empty to keep current' : 'from the K2 dashboard'} />
            <label>API key (webhook secret) {kopo?.apiKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
            <input type="password" value={kopoForm.apiKey} onChange={(e) => setKopoForm({ ...kopoForm, apiKey: e.target.value })}
              placeholder={kopo?.apiKeySet ? '••• leave empty to keep current' : 'optional — for webhook signature'} />
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={saveKopo} disabled={kopoSaving}>{kopoSaving ? 'Saving…' : 'Save Kopo Kopo'}</button>
            </div>
          </div>
        )}

        <div style={{ marginTop: 20, borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: 16 }}>
          <h3 style={{ marginTop: 0, fontSize: 14 }}>Test STK push</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            Fires a live KES&nbsp;1 STK to the phone using the saved creds — confirm the prompt
            arrives and the callback settles. Save your credentials first.
          </p>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Phone</label>
              <input value={mpesaTestPhone}
                onChange={(e) => setMpesaTestPhone(e.target.value)}
                placeholder="2547XXXXXXXX" />
            </div>
            <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
              <button className="ghost" onClick={sendTestStk} disabled={!mpesaTestPhone || mpesaTesting}>
                {mpesaTesting ? 'Sending…' : 'Send test STK'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <p className="sub" style={{ marginTop: 16 }}>
        Sandbox creds come from <a href="https://developer.safaricom.co.ke" target="_blank" rel="noreferrer">developer.safaricom.co.ke</a> →
        My Apps → Lipa Na M-Pesa Sandbox → Consumer Key + Secret.
        The standard sandbox passkey + shortcode 174379 are pre-fillable above.
      </p>

      {form.collectionMethod === 'bank' && form.bankProvider && (
        <div style={{ marginTop: 8 }}>
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>Bank STK API keys — {form.bankProvider === 'kcb' ? 'KCB' : 'Equity (JengaHQ)'}</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            Merchant API credentials for the bank&apos;s own STK Push. Until they&apos;re set, the prompt runs in <strong>simulation</strong>.
          </p>
          <BankStkProviders onToast={setToast} only={form.bankProvider} />
        </div>
      )}

      <CollectionAccountsManager onToast={setToast} />

      <RenewalDunning onToast={setToast} />
      </details>

      </>)}

      {tab === 'sms' && (<>
      <h2 id="sms" style={{ marginTop: 8, scrollMarginTop: 16 }}>SMS provider</h2>
      {sms && (
        <div
          className={`toast ${sms.simulated ? 'err' : 'ok'}`}
          style={{ marginBottom: 12 }}
        >
          Provider: <strong>{sms.provider}</strong>{' '}
          {sms.simulated
            ? '— SIMULATION (API key missing; customer SMS is logged not sent)'
            : '— LIVE'}
        </div>
      )}

      <div className="card">
        <label>Active provider</label>
        <select value={smsForm.provider}
          onChange={(e) => setSmsForm({ ...smsForm, provider: e.target.value as any })}>
          <option value="africastalking">Africa's Talking</option>
          <option value="bytwave">Bytwave</option>
        </select>

        <h3 style={{ fontSize: 14, marginTop: 20, marginBottom: 8 }}>Africa's Talking</h3>
        <div className="row">
          <div>
            <label>Username {sms?.africastalking.apiKeySet && <span style={{ color: 'var(--green)' }}>✓ key set</span>}</label>
            <input value={smsForm.atUsername}
              onChange={(e) => setSmsForm({ ...smsForm, atUsername: e.target.value })}
              placeholder="sandbox" />
          </div>
          <div>
            <label>Sender ID</label>
            <input value={smsForm.atSenderId}
              onChange={(e) => setSmsForm({ ...smsForm, atSenderId: e.target.value })}
              placeholder="HUBNETS" />
          </div>
        </div>
        <label>API key {sms?.africastalking.apiKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
        <input type="password" value={smsForm.atApiKey}
          onChange={(e) => setSmsForm({ ...smsForm, atApiKey: e.target.value })}
          placeholder={sms?.africastalking.apiKeySet ? '••• leave empty to keep current' : 'atsk_...'} />

        <h3 style={{ fontSize: 14, marginTop: 20, marginBottom: 8 }}>Bytwave</h3>
        <div className="row">
          <div>
            <label>Endpoint URL</label>
            <input value={smsForm.bytwaveEndpoint}
              onChange={(e) => setSmsForm({ ...smsForm, bytwaveEndpoint: e.target.value })}
              placeholder="https://portal.bytewavenetworks.com/api/http/sms/send" />
          </div>
          <div>
            <label>Sender ID</label>
            <input value={smsForm.bytwaveSenderId}
              onChange={(e) => setSmsForm({ ...smsForm, bytwaveSenderId: e.target.value })}
              placeholder="HUBNETS" />
          </div>
          <div>
            <label>Payload format</label>
            <select value={smsForm.bytwavePayloadFormat}
              onChange={(e) => setSmsForm({ ...smsForm, bytwavePayloadFormat: e.target.value as any })}>
              <option value="json">JSON</option>
              <option value="form">form-urlencoded</option>
            </select>
          </div>
        </div>
        <label>API key {sms?.bytwave.apiKeySet && <span style={{ color: 'var(--green)' }}>✓ set</span>}</label>
        <input type="password" value={smsForm.bytwaveApiKey}
          onChange={(e) => setSmsForm({ ...smsForm, bytwaveApiKey: e.target.value })}
          placeholder={sms?.bytwave.apiKeySet ? '••• leave empty to keep current' : 'bytwave_...'} />

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={saveSms} disabled={smsSaving}>
            {smsSaving ? 'Saving…' : 'Save SMS settings'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>Send a test SMS</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Fires through the active provider above so you can confirm the creds work
          before relying on them for customer notifications.
        </p>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Phone</label>
            <input value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="2547XXXXXXXX" />
          </div>
          <div style={{ flex: '0 0 auto', alignSelf: 'flex-end', display: 'flex', gap: 6 }}>
            <button className="ghost" onClick={resetSms} type="button"
              style={{ color: '#b91c1c', borderColor: '#fecaca' }}>
              Reset
            </button>
            <button className="ghost" onClick={debugSms} type="button">
              Debug
            </button>
            <button className="ghost" onClick={sendTestSms} disabled={!testPhone || smsTestSending}>
              {smsTestSending ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </div>
      </div>

      </>)}

      {tab === 'hotspot' && (<>
      <h2 style={{ marginTop: 8 }}>Hotspot Template</h2>
      <p className="sub">
        Branding for the captive portal at <code>billing.hubnetwifi.co.ke/hotspot</code>.
        Logo, ISP name, and tagline render at the top of the customer-facing card.
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 340px', minWidth: 0 }}>
        <label>Logo</label>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12 }}>
          {brandForm.logoUrl ? (
            <img
              src={brandForm.logoUrl}
              alt="Logo preview"
              style={{ height: 64, maxWidth: 200, objectFit: 'contain', background: '#f8fafc', borderRadius: 6, padding: 6, border: '1px solid var(--border, #e2e8f0)' }}
            />
          ) : (
            <div style={{ height: 64, width: 64, background: '#f1f5f9', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--muted, #64748b)' }}>
              no logo
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => onLogoFile(e.target.files?.[0] ?? null)}
              style={{ width: 'auto' }}
            />
            {brandForm.logoUrl && (
              <button className="ghost" type="button" onClick={clearLogo}>Remove</button>
            )}
          </div>
        </div>
        <p className="sub" style={{ fontSize: 11, marginTop: 4 }}>
          PNG / JPG / WebP / SVG. Auto-resized to 256 px on the long edge. Anything under 500 KB works.
        </p>

        <label style={{ marginTop: 12 }}>ISP / Venue name</label>
        <input
          value={brandForm.name}
          onChange={(e) => setBrandForm({ ...brandForm, name: e.target.value })}
          placeholder="HUB Networks"
          maxLength={80}
        />

        <label>Tagline</label>
        <input
          value={brandForm.tagline}
          onChange={(e) => setBrandForm({ ...brandForm, tagline: e.target.value })}
          placeholder="Connect to Wi-Fi"
          maxLength={120}
        />

        <label>Brand color</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="color"
            value={brandForm.color}
            onChange={(e) => setBrandForm({ ...brandForm, color: e.target.value })}
            style={{ width: 60, height: 38, padding: 2 }}
          />
          <input
            value={brandForm.color}
            onChange={(e) => setBrandForm({ ...brandForm, color: e.target.value })}
            style={{ flex: 1 }}
            placeholder="#2563eb"
          />
        </div>

        <label style={{ marginTop: 14 }}>Design</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {TEMPLATES.map((t) => {
            const look = templateLook(t.id, brandForm.color, hexToRgb(brandForm.color));
            const on = brandForm.template === t.id;
            return (
              <button key={t.id} type="button" onClick={() => setBrandForm({ ...brandForm, template: t.id })}
                style={{ fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left', padding: 0, borderRadius: 10, overflow: 'hidden',
                  border: `2px solid ${on ? brandForm.color : 'var(--border)'}`, background: 'var(--card)' }}>
                <div style={{ height: 44, background: look.pageBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 68, height: 24, background: look.cardBg, border: look.cardBorder, borderRadius: 6, boxShadow: look.cardShadow }} />
                </div>
                <div style={{ padding: '6px 10px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: on ? brandForm.color : 'var(--text)' }}>{t.label}{on ? ' ✓' : ''}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>{t.hint}</div>
                </div>
              </button>
            );
          })}
        </div>

        <button onClick={saveBrand} disabled={brandSaving} style={{ marginTop: 16 }}>
          {brandSaving ? 'Saving…' : 'Save hotspot template'}
        </button>
      </div>
        <PortalPreview brand={brandForm} plans={previewPlans} />
      </div>

      {brand && (
        <p className="sub" style={{ marginTop: 12 }}>
          The live captive portal at <a href="/hotspot" target="_blank" rel="noreferrer">/hotspot</a> uses these settings.
        </p>
      )}
      </>)}
    </div>
  );
}

/** Live phone-mockup of the captive portal — reflects the branding form as the
 *  operator edits it, using the ISP's real packages (or samples if none yet). */
function PortalPreview({ brand, plans }: { brand: HotspotBranding; plans: HotspotPlanLite[] }) {
  const color = brand.color || '#2563eb';
  const rgb = hexToRgb(color);
  const look = templateLook(brand.template ?? 'classic', color, rgb);
  const sample = plans.length
    ? plans.slice(0, 3).map((p) => ({
        name: p.name,
        price: Math.round(p.price_cents / 100),
        meta: [durLabel(p.validity_minutes, p.validity_days), speedLabel(p.speed_down_kbps)].filter(Boolean).join(' · '),
      }))
    : [
        { name: '1 Hour', price: 20, meta: '1 hour · 5 Mbps' },
        { name: 'Daily', price: 50, meta: '1 day · 5 Mbps' },
        { name: 'Weekly', price: 300, meta: '7 days · 10 Mbps' },
      ];
  return (
    <div style={{ flex: '0 0 300px' }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, fontWeight: 600 }}>Live preview</div>
      <div style={{ width: 300, borderRadius: 30, background: '#0f172a', padding: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.25)' }}>
        <div style={{
          borderRadius: 22, overflow: 'hidden',
          background: look.pageBg,
          padding: 14,
        }}>
          <div style={{ background: look.cardBg, border: look.cardBorder, borderRadius: 16, padding: 16, boxShadow: look.cardShadow }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              {brand.logoUrl && <img src={brand.logoUrl} alt="" style={{ height: 38, width: 38, objectFit: 'contain', flexShrink: 0 }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 19, color: look.wordmark, lineHeight: 1.1, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {brand.name || 'Your ISP'}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{brand.tagline || 'Connect to Wi-Fi'}</div>
              </div>
            </div>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Choose a package</div>
            <div style={{ display: 'grid', gap: 7 }}>
              {sample.map((p, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                  border: i === 0 ? `2px solid ${color}` : '1px solid #e2e8f0',
                  background: i === 0 ? `rgba(${rgb},0.06)` : '#fff',
                  borderRadius: 10, padding: i === 0 ? '7px 9px' : '8px 10px',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: i === 0 ? color : '#0f172a' }}>{p.name}</div>
                    {p.meta && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{p.meta}</div>}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>KES</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: i === 0 ? color : '#0f172a', lineHeight: 1 }}>{p.price}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ background: color, color: '#fff', textAlign: 'center', borderRadius: 10, padding: 11, fontWeight: 700, fontSize: 13, marginTop: 12, boxShadow: `0 4px 14px rgba(${rgb},0.30)` }}>
              Pay &amp; Connect
            </div>
            <div style={{ textAlign: 'center', marginTop: 10, fontSize: 10, color: '#15803d', fontWeight: 600 }}>🔒 Secure payment via M-Pesa</div>
          </div>
        </div>
      </div>
    </div>
  );
}

type CAMethod = 'paybill' | 'till' | 'bank';
interface CollectionAccount {
  id: string; label: string; method: CAMethod;
  paybill: string; till: string; account_no: string; account_name: string;
  is_default: boolean; provider: string; provider_env: string;
}
const BLANK_CA = { label: '', method: 'bank' as CAMethod, paybill: '', till: '', account_no: '', account_name: '', is_default: false, provider: '', provider_env: 'sandbox' };

/** Manage the ISP's no-API collection destinations (paybill / till / bank) that
 *  can be assigned per router on the Routers page. The default account collects
 *  for any router that isn't pinned to a specific one. */
function CollectionAccountsManager({ onToast }: { onToast: (t: { ok: boolean; msg: string }) => void }) {
  const [list, setList] = useState<CollectionAccount[]>([]);
  const [form, setForm] = useState({ ...BLANK_CA });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<CollectionAccount[]>('/settings/collection-accounts')
      .then(setList)
      .catch(() => {/* endpoint absent before deploy — ignore */});
  useEffect(() => { load(); }, []);

  const startNew = () => { setEditingId(null); setForm({ ...BLANK_CA }); setOpen(true); };
  const startEdit = (a: CollectionAccount) => {
    setEditingId(a.id);
    setForm({ label: a.label, method: a.method, paybill: a.paybill, till: a.till, account_no: a.account_no, account_name: a.account_name, is_default: a.is_default, provider: a.provider ?? '', provider_env: a.provider_env ?? 'sandbox' });
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = JSON.stringify(form);
      if (editingId) await api(`/settings/collection-accounts/${editingId}`, { method: 'PUT', body });
      else await api('/settings/collection-accounts', { method: 'POST', body });
      onToast({ ok: true, msg: editingId ? 'Collection account updated' : 'Collection account added' });
      setOpen(false); setEditingId(null); setForm({ ...BLANK_CA });
      await load();
    } catch (e: any) { onToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };
  const del = async (a: CollectionAccount) => {
    if (!window.confirm(`Delete collection account "${a.label}"? Routers using it fall back to the default.`)) return;
    setBusy(true);
    try { await api(`/settings/collection-accounts/${a.id}`, { method: 'DELETE' }); onToast({ ok: true, msg: 'Deleted' }); await load(); }
    catch (e: any) { onToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };
  const makeDefault = async (a: CollectionAccount) => {
    setBusy(true);
    try { await api(`/settings/collection-accounts/${a.id}/default`, { method: 'POST' }); onToast({ ok: true, msg: `"${a.label}" is now the default` }); await load(); }
    catch (e: any) { onToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };

  const dest = (a: CollectionAccount) =>
    a.method === 'bank' ? `Paybill ${a.paybill} · acct ${a.account_no}`
    : a.method === 'till' ? `Till ${a.till}`
    : `Paybill ${a.paybill}`;

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Collection accounts</h2>
        <button className="ghost sm" style={{ marginLeft: 'auto' }} onClick={startNew}>+ Add account</button>
      </div>
      <p className="sub">Paybill / Till / Bank destinations you can assign per MikroTik on the Routers page. The <strong>default</strong> collects for any router not pinned to a specific one.</p>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              <th style={{ padding: '10px 12px' }}>Label</th>
              <th style={{ padding: '10px 12px' }}>Method</th>
              <th style={{ padding: '10px 12px' }}>Destination</th>
              <th style={{ padding: '10px 12px' }}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                  {a.label} {a.is_default && <span style={{ fontSize: 11, color: '#16a34a' }}>· default</span>}
                </td>
                <td style={{ padding: '10px 12px', textTransform: 'capitalize' }}>
                  {a.method}
                  {a.provider && <span style={{ marginLeft: 6, fontSize: 11, color: '#2563eb', textTransform: 'none' }}>⚡ {a.provider === 'equity_jenga' ? 'Equity STK' : a.provider === 'kcb' ? 'KCB STK' : 'auto'}</span>}
                </td>
                <td style={{ padding: '10px 12px' }}>{dest(a)}</td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {!a.is_default && <button className="ghost sm" disabled={busy} onClick={() => makeDefault(a)}>Make default</button>}
                    <button className="ghost sm" disabled={busy} onClick={() => startEdit(a)}>Edit</button>
                    <button className="danger sm" disabled={busy} onClick={() => del(a)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={4}><div className="empty-state"><span className="icon">🏦</span>No collection accounts yet — add one, then assign routers to it.</div></td></tr>}
          </tbody>
        </table>
      </div>

      {list.some((a) => a.provider) && <BankStkProviders onToast={onToast} />}

      {open && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0, fontSize: 14 }}>{editingId ? 'Edit' : 'New'} collection account</h3>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Label</label>
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Equity - Main, KCB Westlands" />
            </div>
            <div style={{ flex: '0 0 180px' }}>
              <label>Method</label>
              <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as CAMethod })}>
                <option value="bank">Bank</option>
                <option value="paybill">Paybill</option>
                <option value="till">Till</option>
              </select>
            </div>
          </div>
          {form.method === 'till' ? (
            <>
              <label>Till number</label>
              <input value={form.till} onChange={(e) => setForm({ ...form, till: e.target.value })} placeholder="e.g. 5200000" />
            </>
          ) : form.method === 'bank' ? (
            <div className="row">
              <div style={{ flex: 1 }}>
                <label>Bank Paybill (shared)</label>
                <input value={form.paybill} onChange={(e) => setForm({ ...form, paybill: e.target.value })} placeholder="e.g. Equity 247247, KCB 522522" />
              </div>
              <div style={{ flex: 1 }}>
                <label>Bank account number</label>
                <input value={form.account_no} onChange={(e) => setForm({ ...form, account_no: e.target.value })} placeholder="your account no. (routing key)" />
              </div>
              <div style={{ flex: 1 }}>
                <label>Account name</label>
                <input value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} placeholder="name on the account" />
              </div>
            </div>
          ) : (
            <>
              <label>Paybill number</label>
              <input value={form.paybill} onChange={(e) => setForm({ ...form, paybill: e.target.value })} placeholder="e.g. 400200" />
            </>
          )}
          {form.method === 'bank' && (
            <div className="row" style={{ marginTop: 4 }}>
              <div style={{ flex: 1 }}>
                <label>Collection mode</label>
                <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                  <option value="">Manual — customer pays the paybill by hand</option>
                  <option value="equity_jenga">Automated STK — Equity (JengaHQ)</option>
                  <option value="kcb">Automated STK — KCB</option>
                </select>
                <p className="sub" style={{ marginTop: 4, fontSize: 12 }}>Automated fires the bank&apos;s STK prompt — the customer just enters their PIN and the bank deposits to this account. Add the bank API keys in the panel below.</p>
              </div>
              {form.provider && (
                <div style={{ flex: '0 0 150px' }}>
                  <label>Environment</label>
                  <select value={form.provider_env} onChange={(e) => setForm({ ...form, provider_env: e.target.value })}>
                    <option value="sandbox">Sandbox</option>
                    <option value="live">Live</option>
                  </select>
                </div>
              )}
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} />
            Make this the default collection account
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button onClick={save} disabled={busy || !form.label.trim()}>{busy ? 'Saving…' : 'Save account'}</button>
            <button className="ghost" onClick={() => { setOpen(false); setEditingId(null); }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface BankProviderPublic {
  provider: 'equity_jenga' | 'kcb';
  merchantCode: string;
  consumerKeySet: boolean; consumerSecretSet: boolean; apiKeySet: boolean; signingKeySet: boolean;
  configured: boolean;
}
const PROVIDER_LABELS: Record<string, string> = { equity_jenga: 'Equity (JengaHQ)', kcb: 'KCB (Buni)' };

/** Bank STK merchant API credentials (per bank). Required to turn a bank
 *  collection account from "manual" into an automated STK prompt. Until keys are
 *  set the flow runs in SIMULATION so it can be demoed end-to-end. */
function BankStkProviders({ onToast, only }: { onToast: (t: { ok: boolean; msg: string }) => void; only?: string }) {
  const [providers, setProviders] = useState<BankProviderPublic[]>([]);
  const [forms, setForms] = useState<Record<string, { merchantCode: string; consumerKey: string; consumerSecret: string; apiKey: string; signingKey: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api<BankProviderPublic[]>('/settings/bank-providers')
      .then((ps) => {
        setProviders(ps);
        setForms((f) => {
          const next = { ...f };
          for (const p of ps) if (!next[p.provider]) next[p.provider] = { merchantCode: p.merchantCode, consumerKey: '', consumerSecret: '', apiKey: '', signingKey: '' };
          return next;
        });
      })
      .catch(() => {/* before deploy */});
  useEffect(() => { load(); }, []);

  const save = async (provider: string) => {
    setBusy(provider);
    try {
      const f = forms[provider];
      const body: Record<string, string> = { merchantCode: f.merchantCode };
      if (f.consumerKey) body.consumerKey = f.consumerKey;
      if (f.consumerSecret) body.consumerSecret = f.consumerSecret;
      if (f.apiKey) body.apiKey = f.apiKey;
      if (f.signingKey) body.signingKey = f.signingKey;
      await api(`/settings/bank-providers/${provider}`, { method: 'PUT', body: JSON.stringify(body) });
      onToast({ ok: true, msg: `${PROVIDER_LABELS[provider]} keys saved` });
      setForms((s) => ({ ...s, [provider]: { ...s[provider], consumerKey: '', consumerSecret: '', apiKey: '', signingKey: '' } }));
      await load();
    } catch (e: any) { onToast({ ok: false, msg: e.message }); }
    finally { setBusy(null); }
  };

  const setF = (p: string, k: string, v: string) => setForms((s) => ({ ...s, [p]: { ...s[p], [k]: v } }));

  return (
    <div style={{ marginTop: only ? 0 : 16 }}>
      {!only && (
        <>
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>Bank STK API keys</h3>
          <p className="sub" style={{ marginTop: 0 }}>Merchant API credentials for the bank&apos;s own STK Push. Until a bank&apos;s keys are set, its automated accounts run in <strong>simulation</strong>. Secrets are write-only.</p>
        </>
      )}
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        {providers.filter((p) => !only || p.provider === only).map((p) => {
          const f = forms[p.provider]; if (!f) return null;
          const isEquity = p.provider === 'equity_jenga';
          return (
            <div key={p.provider} className="card">
              <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>
                {PROVIDER_LABELS[p.provider]} {p.configured && <span style={{ color: '#16a34a', fontSize: 11 }}>✓ configured</span>}
              </h4>
              {isEquity && (
                <>
                  <label>Merchant code</label>
                  <input value={f.merchantCode} onChange={(e) => setF(p.provider, 'merchantCode', e.target.value)} placeholder="JengaHQ merchant code" />
                </>
              )}
              <label>Consumer key {p.consumerKeySet && <span style={{ color: '#16a34a' }}>✓</span>}</label>
              <input type="password" value={f.consumerKey} onChange={(e) => setF(p.provider, 'consumerKey', e.target.value)} placeholder={p.consumerKeySet ? '••• keep current' : 'consumer key'} />
              <label>Consumer secret {p.consumerSecretSet && <span style={{ color: '#16a34a' }}>✓</span>}</label>
              <input type="password" value={f.consumerSecret} onChange={(e) => setF(p.provider, 'consumerSecret', e.target.value)} placeholder={p.consumerSecretSet ? '••• keep current' : 'consumer secret'} />
              <label>API key {p.apiKeySet && <span style={{ color: '#16a34a' }}>✓</span>}</label>
              <input type="password" value={f.apiKey} onChange={(e) => setF(p.provider, 'apiKey', e.target.value)} placeholder={p.apiKeySet ? '••• keep current' : isEquity ? 'JengaHQ Api-Key' : 'KCB API key'} />
              {isEquity && (
                <>
                  <label>Signing key {p.signingKeySet && <span style={{ color: '#16a34a' }}>✓</span>}</label>
                  <input type="password" value={f.signingKey} onChange={(e) => setF(p.provider, 'signingKey', e.target.value)} placeholder={p.signingKeySet ? '••• keep current' : 'RSA private key (PEM)'} />
                </>
              )}
              <button style={{ marginTop: 12 }} disabled={busy === p.provider} onClick={() => save(p.provider)}>{busy === p.provider ? 'Saving…' : 'Save'}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DunningCfg { enabled: boolean; maxAttempts: number; windowHours: number; graceHours: number; eligible: number }

/** Opt-in auto-STK renewal prompts for lapsing manual-pay PPPoE customers. */
function RenewalDunning({ onToast }: { onToast: (t: { ok: boolean; msg: string }) => void }) {
  const [cfg, setCfg] = useState<DunningCfg | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<DunningCfg>('/settings/renewal-dunning').then(setCfg).catch(() => {/* before deploy */});
  useEffect(() => { load(); }, []);

  const save = async (patch: Partial<DunningCfg>) => {
    if (!cfg) return;
    setBusy(true);
    try {
      const next = await api<DunningCfg>('/settings/renewal-dunning', {
        method: 'PUT',
        body: JSON.stringify({ ...{ enabled: cfg.enabled, maxAttempts: cfg.maxAttempts, windowHours: cfg.windowHours, graceHours: cfg.graceHours }, ...patch }),
      });
      setCfg(next);
      onToast({ ok: true, msg: 'Renewal prompts updated' });
    } catch (e: any) { onToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ enabled: boolean; fired: number; eligible: number; skipped?: string }>('/settings/renewal-dunning/run', { method: 'POST' });
      onToast({ ok: !r.skipped, msg: r.skipped ? r.skipped : `Sent ${r.fired} prompt${r.fired === 1 ? '' : 's'} (${r.eligible} eligible)` });
      await load();
    } catch (e: any) { onToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };

  if (!cfg) return null;
  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ margin: 0 }}>Auto-renew prompts (STK)</h2>
      <p className="sub">
        When a manual-pay PPPoE customer is about to lapse (or just has), automatically send them an
        M-Pesa STK prompt so they renew with one PIN tap. Wallet auto-renew customers are unaffected.
        Runs hourly with the expire worker. <strong>Needs M-Pesa STK (Daraja) configured above.</strong>
      </p>
      <div className="card">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={cfg.enabled} disabled={busy}
            onChange={(e) => save({ enabled: e.target.checked })} />
          <span><strong>Enabled</strong> — fire renewal prompts automatically</span>
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Prompt this many hours BEFORE expiry</label>
            <input type="number" min={1} max={168} defaultValue={cfg.windowHours}
              onBlur={(e) => Number(e.target.value) !== cfg.windowHours && save({ windowHours: Number(e.target.value) })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>Keep prompting hours AFTER expiry</label>
            <input type="number" min={0} max={720} defaultValue={cfg.graceHours}
              onBlur={(e) => Number(e.target.value) !== cfg.graceHours && save({ graceHours: Number(e.target.value) })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>Max prompts per cycle</label>
            <input type="number" min={1} max={10} defaultValue={cfg.maxAttempts}
              onBlur={(e) => Number(e.target.value) !== cfg.maxAttempts && save({ maxAttempts: Number(e.target.value) })} />
          </div>
        </div>
        <p className="sub" style={{ marginTop: 10 }}>
          <strong>{cfg.eligible}</strong> customer{cfg.eligible === 1 ? '' : 's'} eligible right now
          {' '}(min 20h between prompts to the same customer).
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="ghost" disabled={busy || !cfg.enabled} onClick={runNow}>{busy ? 'Working…' : 'Run now'}</button>
        </div>
      </div>
    </div>
  );
}
