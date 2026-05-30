'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function Routers() {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', host: '', api_port: '8728', type: 'mikrotik', site: '' });
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => api('/routers').then(setList).catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      await api('/routers', { method: 'POST', body: JSON.stringify({ name: form.name, host: form.host, api_port: Number(form.api_port), type: form.type, site: form.site || undefined }) });
      setToast({ ok: true, msg: 'Router registered' });
      setForm({ name: '', host: '', api_port: '8728', type: 'mikrotik', site: '' });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  return (
    <div className="container">
      <h1>Router Registry</h1>
      <p className="sub">The Mikrotik / RADIUS fleet. Provisioning targets the router a subscriber is homed on.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <div className="row">
          <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Host / IP</label><input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></div>
          <div><label>API port</label><input value={form.api_port} onChange={(e) => setForm({ ...form, api_port: e.target.value })} /></div>
          <div><label>Type</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="mikrotik">Mikrotik</option>
              <option value="radius">RADIUS</option>
            </select>
          </div>
          <div><label>Site</label><input value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} /></div>
          <div style={{ flex: '0 0 auto' }}><button disabled={!form.name || !form.host} onClick={create}>Register</button></div>
        </div>
      </div>

      <table>
        <thead><tr><th>Name</th><th>Host</th><th>Port</th><th>Type</th><th>Site</th><th>Status</th></tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.host}</td>
              <td>{r.api_port}</td>
              <td>{r.type}</td>
              <td>{r.site ?? '—'}</td>
              <td><span className={`badge ${r.status === 'online' ? 'active' : r.status === 'offline' ? 'suspended' : 'pending'}`}>{r.status}</span></td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No routers yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
