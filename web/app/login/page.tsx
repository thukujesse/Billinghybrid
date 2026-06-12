'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken, getToken } from '@/lib/api';

export default function Login() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [me, setMe] = useState<any>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    // Platform operator impersonation: a one-time admin token arrives via ?imp=.
    // Store it and bounce to the dashboard (stripping the param from the URL).
    const imp = new URLSearchParams(window.location.search).get('imp');
    if (imp) { setToken(imp); window.location.replace('/'); return; }
    if (getToken()) api('/auth/me').then(setMe).catch(() => setToken(null));
    // Is this a fresh install with no operator accounts? Then offer first-admin setup.
    api<{ needsSetup: boolean }>('/auth/setup-status')
      .then((s) => setNeedsSetup(s.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  const goHome = () => router.replace('/');

  const login = async () => {
    setBusy(true);
    try {
      const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setToken(r.token);
      setMe(r.user);
      setToast({ ok: true, msg: `Signed in as ${r.user.username} (${r.user.role})` });
      goHome();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };

  const register = async () => {
    if (password !== confirm) { setToast({ ok: false, msg: 'Passwords do not match' }); return; }
    setBusy(true);
    try {
      const r = await api('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
      setToken(r.token);
      setMe(r.user);
      setNeedsSetup(false);
      setToast({ ok: true, msg: `Admin account created — welcome, ${r.user.username}` });
      goHome();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
    finally { setBusy(false); }
  };

  const logout = () => { setToken(null); setMe(null); setToast({ ok: true, msg: 'Signed out' }); };

  if (me) {
    return (
      <div className="container" style={{ maxWidth: 460 }}>
        <h1>Account</h1>
        {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}
        <div className="card">
          <p>Signed in as <strong>{me.username ?? me.sub}</strong> — role <span className="badge active">{me.role}</span></p>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button onClick={goHome}>Go to dashboard</button>
            <button className="ghost" onClick={logout}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  if (needsSetup) {
    return (
      <div className="container" style={{ maxWidth: 460 }}>
        <h1>Create your admin account</h1>
        <p className="sub">No operator accounts exist yet. Create the first administrator to secure this dashboard. You can invite staff from Users afterwards.</p>
        {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}
        <div className="card">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoFocus />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 6 characters" />
          <label>Confirm password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && register()} />
          <button style={{ marginTop: 14 }} onClick={register} disabled={busy || username.length < 3 || password.length < 6}>
            {busy ? 'Creating…' : 'Create admin & continue'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <h1>Staff Sign-in</h1>
      <p className="sub">Admin / staff login. Sign in to access the dashboard.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}
      <div className="card">
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
        <button style={{ marginTop: 14 }} onClick={login} disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
      <p className="sub" style={{ marginTop: 14, textAlign: 'center' }}>
        New here? <a href="/register">Register your ISP →</a>
      </p>
    </div>
  );
}
