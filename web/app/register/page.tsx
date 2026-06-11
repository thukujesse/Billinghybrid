'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface SignupInfo { selfServe: boolean; baseDomain: string }
interface ProvisionResult { host: string; loginUrl: string; tenant: { slug: string; name: string } }

export default function RegisterIsp() {
  const [info, setInfo] = useState<SignupInfo | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugMsg, setSlugMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminPassword, setAdminPassword] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SignupInfo>('/tenants/signup-info').then(setInfo).catch(() => setInfo({ selfServe: false, baseDomain: '' }));
  }, []);

  // Auto-suggest a slug from the ISP name until the user edits it directly.
  const [slugEdited, setSlugEdited] = useState(false);
  useEffect(() => {
    if (slugEdited) return;
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    setSlug(s);
  }, [name, slugEdited]);

  // Debounced availability check.
  useEffect(() => {
    if (slug.length < 3) { setSlugMsg(null); return; }
    const id = setTimeout(() => {
      api<{ available: boolean; reason?: string }>(`/tenants/slug-available?slug=${encodeURIComponent(slug)}`)
        .then((r) => setSlugMsg(r.available
          ? { ok: true, text: `${slug}.${info?.baseDomain ?? ''} is available` }
          : { ok: false, text: r.reason || 'not available' }))
        .catch(() => setSlugMsg(null));
    }, 400);
    return () => clearTimeout(id);
  }, [slug, info?.baseDomain]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<ProvisionResult>('/tenants/register', {
        method: 'POST',
        body: JSON.stringify({
          name, slug, adminUsername, adminPassword,
          contactPhone: contactPhone || undefined,
          contactEmail: contactEmail || undefined,
        }),
      });
      setDone(r);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="container" style={{ maxWidth: 520 }}>
        <h1>🎉 {done.tenant.name} is live</h1>
        <div className="card">
          <p>Your ISP workspace has been provisioned with its own isolated database.</p>
          <p style={{ marginTop: 10 }}>Your dashboard:</p>
          <p><a href={done.loginUrl} style={{ fontWeight: 700 }}>{done.host}</a></p>
          <p className="sub" style={{ marginTop: 10 }}>
            Sign in with the admin account you just created. Point your DNS / subdomain at this platform if you haven’t already.
          </p>
          <a href={done.loginUrl}><button style={{ marginTop: 14 }}>Go to my dashboard →</button></a>
        </div>
      </div>
    );
  }

  if (info && !info.selfServe) {
    return (
      <div className="container" style={{ maxWidth: 520 }}>
        <h1>Register your ISP</h1>
        <div className="card"><p>Self-serve signup is currently closed. Please contact the platform operator to onboard your ISP.</p></div>
      </div>
    );
  }

  return (
    <div className="container" style={{ maxWidth: 520 }}>
      <h1>Register your ISP</h1>
      <p className="sub">Spin up your own billing workspace — isolated database, your own admin, your own subdomain.</p>
      {error && <div className="toast err">{error}</div>}
      <div className="card">
        <label>ISP / business name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Networks" autoFocus />

        <label>Subdomain</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            value={slug}
            onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }}
            placeholder="acme"
            style={{ flex: 1 }}
          />
          <span className="sub" style={{ whiteSpace: 'nowrap' }}>.{info?.baseDomain ?? '…'}</span>
        </div>
        {slugMsg && <p className="sub" style={{ color: slugMsg.ok ? 'var(--ok, #16a34a)' : 'var(--err, #dc2626)', marginTop: 4 }}>{slugMsg.text}</p>}

        <label style={{ marginTop: 10 }}>Admin username</label>
        <input value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} />
        <label>Admin password</label>
        <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="at least 6 characters" />

        <label style={{ marginTop: 10 }}>Contact phone (optional)</label>
        <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="07XXXXXXXX" />
        <label>Contact email (optional)</label>
        <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="you@acme.co.ke" />

        <button
          style={{ marginTop: 16 }}
          onClick={submit}
          disabled={busy || !name || slug.length < 3 || adminUsername.length < 3 || adminPassword.length < 6 || (slugMsg ? !slugMsg.ok : false)}
        >
          {busy ? 'Provisioning your workspace… (this takes a few seconds)' : 'Create my ISP workspace'}
        </button>
      </div>
    </div>
  );
}
