'use client';
import { useEffect, useState } from 'react';
import { api, setToken, getToken } from '@/lib/api';

export default function Login() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [me, setMe] = useState<any>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (getToken()) api('/auth/me').then(setMe).catch(() => setToken(null));
  }, []);

  const login = async () => {
    try {
      const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setToken(r.token);
      setMe(r.user);
      setToast({ ok: true, msg: `Signed in as ${r.user.username} (${r.user.role})` });
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };
  const logout = () => { setToken(null); setMe(null); setToast({ ok: true, msg: 'Signed out' }); };

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <h1>Staff Sign-in</h1>
      <p className="sub">Admin / staff login (JWT + RBAC). Demo: <code>admin</code> / <code>admin123</code>. Auth is enforced only when the API runs with <code>AUTH_ENABLED=true</code>.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      {me ? (
        <div className="card">
          <p>Signed in as <strong>{me.username ?? me.sub}</strong> — role <span className="badge active">{me.role}</span></p>
          <button className="ghost" style={{ marginTop: 12 }} onClick={logout}>Sign out</button>
        </div>
      ) : (
        <div className="card">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
          <button style={{ marginTop: 14 }} onClick={login} disabled={!username || !password}>Sign in</button>
        </div>
      )}
    </div>
  );
}
