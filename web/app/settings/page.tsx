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
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

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
        setForm((f) => ({ ...f, env: m.env, shortcode: m.shortcode }));
      })
      .catch((e: any) => setToast({ ok: false, msg: e.message }));

  const loadBrand = () =>
    api<HotspotBranding>('/admin/hotspot-branding')
      .then((b) => { setBrand(b); setBrandForm(b); })
      .catch((e: any) => setToast({ ok: false, msg: e.message }));

  useEffect(() => { load(); loadBrand(); }, []);

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
      </div>

      <p className="sub" style={{ marginTop: 16 }}>
        Sandbox creds come from <a href="https://developer.safaricom.co.ke" target="_blank" rel="noreferrer">developer.safaricom.co.ke</a> →
        My Apps → Lipa Na M-Pesa Sandbox → Consumer Key + Secret.
        The standard sandbox passkey + shortcode 174379 are pre-fillable above.
      </p>

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
