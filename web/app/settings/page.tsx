'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface MpesaPublic {
  env: 'sandbox' | 'production';
  shortcode: string;
  consumerKeySet: boolean;
  consumerSecretSet: boolean;
  passkeySet: boolean;
  simulated: boolean;
  collectionMethod: 'stk' | 'c2b';
}

interface SmsPublic {
  provider: 'africastalking' | 'bytwave';
  africastalking: { username: string; senderId: string; apiKeySet: boolean };
  bytwave: { endpoint: string; senderId: string; payloadFormat: 'json' | 'form'; apiKeySet: boolean };
  simulated: boolean;
}

interface HotspotBranding {
  name: string;
  color: string;
  tagline: string;
  logoUrl: string | null;
}

const SANDBOX_PASSKEY =
  'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

export default function SettingsPage() {
  const [mpesa, setMpesa] = useState<MpesaPublic | null>(null);
  const [form, setForm] = useState({
    env: 'sandbox' as 'sandbox' | 'production',
    shortcode: '174379',
    consumerKey: '',
    consumerSecret: '',
    passkey: '',
    collectionMethod: 'stk' as 'stk' | 'c2b',
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [mpesaTestPhone, setMpesaTestPhone] = useState('');
  const [mpesaTesting, setMpesaTesting] = useState(false);
  const [registeringC2b, setRegisteringC2b] = useState(false);

  // Hotspot template branding (logo, ISP name, tagline, brand color).
  // Drives the captive portal at billing.hubnetwifi.co.ke/hotspot.
  const [brand, setBrand] = useState<HotspotBranding | null>(null);
  const [brandForm, setBrandForm] = useState<HotspotBranding>({
    name: '', color: '#2563eb', tagline: '', logoUrl: null,
  });
  const [brandSaving, setBrandSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api<MpesaPublic>('/settings/mpesa')
      .then((m) => {
        setMpesa(m);
        setForm((f) => ({ ...f, env: m.env, shortcode: m.shortcode, collectionMethod: m.collectionMethod }));
      })
      .catch((e: any) => setToast({ ok: false, msg: e.message }));

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

  useEffect(() => { load(); loadBrand(); loadSms(); }, []);

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

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        env: form.env,
        shortcode: form.shortcode,
        collectionMethod: form.collectionMethod,
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
      setForm({ ...form, consumerKey: '', consumerSecret: '', passkey: '' });
      setToast({ ok: true, msg: 'M-Pesa settings saved' });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setSaving(false);
    }
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

      <h2>M-Pesa (Daraja)</h2>
      {mpesa && (
        <div
          className={`toast ${mpesa.simulated ? 'err' : 'ok'}`}
          style={{ marginBottom: 12 }}
        >
          Status:{' '}
          {mpesa.simulated
            ? 'SIMULATION (missing one or more credentials — STK pushes won\'t go to Safaricom)'
            : `LIVE (${mpesa.env} · shortcode ${mpesa.shortcode})`}
        </div>
      )}

      <div className="card">
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
            <label>Shortcode (Paybill)</label>
            <input
              value={form.shortcode}
              onChange={(e) => setForm({ ...form, shortcode: e.target.value })}
              placeholder="174379"
            />
          </div>
        </div>

        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Collection method</label>
            <select
              value={form.collectionMethod}
              onChange={(e) => setForm({ ...form, collectionMethod: e.target.value as 'stk' | 'c2b' })}
            >
              <option value="stk">STK Push — prompt on customer&apos;s phone</option>
              <option value="c2b">Paybill / Bank — pay our Paybill, account = phone (auto-approved)</option>
            </select>
            <p className="sub" style={{ marginTop: 4 }}>
              {form.collectionMethod === 'c2b'
                ? 'Customer pays the Paybill with account = their phone; Safaricom\'s callback auto-registers and approves them. No STK and no M-Pesa API of your own — so this also covers operators who only collect into a bank. Register the C2B URLs once (below).'
                : 'Portal sends an STK push to the customer\'s phone. Needs your own Passkey + Consumer Key/Secret.'}
            </p>
          </div>
        </div>

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

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="ghost" onClick={usePresetSandbox} disabled={saving}>
            Pre-fill sandbox passkey
          </button>
        </div>

        {form.collectionMethod === 'c2b' && (
          <div style={{ marginTop: 20, borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>Paybill / Bank setup (no per-tenant API)</h3>
            <p className="sub" style={{ marginTop: 0 }}>
              One-time: register the confirmation/validation URLs with Safaricom so every payment to
              Paybill <strong>{form.shortcode}</strong> POSTs back here and auto-activates the customer
              by their phone number. This single Paybill sits behind operators who have no M-Pesa API
              of their own (e.g. they only collect into a bank). Save Consumer Key/Secret + Shortcode first.
            </p>
            <button className="ghost" onClick={registerC2bUrls} disabled={registeringC2b || saving}>
              {registeringC2b ? 'Registering…' : 'Register C2B URLs'}
            </button>
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

      <h2 style={{ marginTop: 32 }}>SMS provider</h2>
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

      <h2 style={{ marginTop: 32 }}>Hotspot Template</h2>
      <p className="sub">
        Branding for the captive portal at <code>billing.hubnetwifi.co.ke/hotspot</code>.
        Logo, ISP name, and tagline render at the top of the customer-facing card.
      </p>

      <div className="card">
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

        <button onClick={saveBrand} disabled={brandSaving} style={{ marginTop: 16 }}>
          {brandSaving ? 'Saving…' : 'Save hotspot template'}
        </button>
      </div>

      {brand && (
        <p className="sub" style={{ marginTop: 12 }}>
          Preview: <a href="/hotspot" target="_blank" rel="noreferrer">/hotspot</a> uses these settings.
        </p>
      )}
    </div>
  );
}
