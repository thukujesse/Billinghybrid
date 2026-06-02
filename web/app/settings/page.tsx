'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface MpesaPublic {
  env: 'sandbox' | 'production';
  shortcode: string;
  consumerKeySet: boolean;
  consumerSecretSet: boolean;
  passkeySet: boolean;
  simulated: boolean;
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

  const load = () =>
    api<MpesaPublic>('/settings/mpesa')
      .then((m) => {
        setMpesa(m);
        setForm((f) => ({ ...f, env: m.env, shortcode: m.shortcode }));
      })
      .catch((e: any) => setToast({ ok: false, msg: e.message }));

  useEffect(() => { load(); }, []);

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
    </div>
  );
}
