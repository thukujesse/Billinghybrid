'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Lead {
  id: string; name: string; phone: string | null; email: string | null;
  stage: string; service_interest: string | null; source: string | null;
  landmark: string | null; notes: string | null;
  latitude: number | null; longitude: number | null;
  converted_customer_id: string | null; created_at: string;
}

const STAGES = ['lead', 'survey', 'scheduled', 'installing', 'active', 'on_hold', 'lost'] as const;
const STAGE_LABEL: Record<string, string> = {
  lead: 'Lead', survey: 'Survey', scheduled: 'Scheduled', installing: 'Installing',
  active: 'Active', on_hold: 'On hold', lost: 'Lost',
};
const STAGE_COLOR: Record<string, string> = {
  lead: '#ca8a04', survey: '#d97706', scheduled: '#2563eb', installing: '#7c3aed',
  active: '#16a34a', on_hold: '#64748b', lost: '#dc2626',
};
// Stages an operator can move a lead INTO manually (active is reached via Convert).
const MOVE_STAGES = ['lead', 'survey', 'scheduled', 'installing', 'on_hold', 'lost'];

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<string>('');
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '', phone: '', service_interest: 'hotspot', source: 'walk-in', landmark: '', notes: '',
    latitude: null as number | null, longitude: null as number | null,
  });
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const q = filter ? `?stage=${filter}` : '';
      setLeads(await api<Lead[]>(`/admin/leads${q}`));
      setStats(await api<Record<string, number>>('/admin/leads/stats'));
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  const useGps = () => {
    if (!navigator.geolocation) { setToast({ ok: false, msg: 'No geolocation on this device' }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setForm((f) => ({ ...f, latitude: +p.coords.latitude.toFixed(6), longitude: +p.coords.longitude.toFixed(6) })),
      () => setToast({ ok: false, msg: 'Could not get GPS (permission denied?)' }),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const addLead = async () => {
    if (!form.name.trim()) { setToast({ ok: false, msg: 'Name required' }); return; }
    setAdding(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name, phone: form.phone || undefined, service_interest: form.service_interest,
        source: form.source, landmark: form.landmark || undefined, notes: form.notes || undefined,
      };
      if (form.latitude != null && form.longitude != null) { body.latitude = form.latitude; body.longitude = form.longitude; }
      await api('/admin/leads', { method: 'POST', body: JSON.stringify(body) });
      setForm({ name: '', phone: '', service_interest: 'hotspot', source: 'walk-in', landmark: '', notes: '', latitude: null, longitude: null });
      setToast({ ok: true, msg: 'Lead added' });
      await load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setAdding(false); }
  };

  const move = async (id: string, to: string) => {
    setBusy(id);
    try { await api(`/admin/leads/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }); await load(); }
    catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setBusy(null); }
  };
  const convert = async (id: string) => {
    setBusy(id);
    try {
      const r = await api<{ customerId: string }>(`/admin/leads/${id}/convert`, { method: 'POST' });
      setToast({ ok: true, msg: `Converted → customer ${r.customerId.slice(0, 8)}. Add their service next.` });
      await load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setBusy(null); }
  };
  const setGps = async (id: string) => {
    if (!navigator.geolocation) { setToast({ ok: false, msg: 'No geolocation' }); return; }
    navigator.geolocation.getCurrentPosition(async (p) => {
      try { await api(`/admin/leads/${id}/location`, { method: 'PUT', body: JSON.stringify({ latitude: +p.coords.latitude.toFixed(6), longitude: +p.coords.longitude.toFixed(6) }) }); await load(); }
      catch (e: any) { setToast({ ok: false, msg: e.message }); }
    }, () => setToast({ ok: false, msg: 'GPS denied' }), { enableHighAccuracy: true, timeout: 8000 });
  };
  const del = async (id: string) => {
    setBusy(id);
    try { await api(`/admin/leads/${id}`, { method: 'DELETE' }); await load(); }
    catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setBusy(null); }
  };

  return (
    <div className="container">
      <h1>Leads</h1>
      <p className="sub">Prospects before installation — capture demand, run the funnel, convert to customers. Located leads show as yellow pins on the <a href="/network/twin">Live map</a>.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      {/* Funnel */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button className={filter === '' ? '' : 'ghost'} onClick={() => setFilter('')} style={{ padding: '6px 12px', fontSize: 12 }}>
          All {Object.values(stats).reduce((a, b) => a + b, 0) || 0}
        </button>
        {STAGES.map((s) => (
          <button key={s} className={filter === s ? '' : 'ghost'} onClick={() => setFilter(s)}
            style={{ padding: '6px 12px', fontSize: 12, borderLeft: `3px solid ${STAGE_COLOR[s]}` }}>
            {STAGE_LABEL[s]} <strong>{stats[s] ?? 0}</strong>
          </button>
        ))}
      </div>

      {/* Add lead */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Add a lead</h2>
        <div className="row">
          <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Customer name" /></div>
          <div><label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="07XX…" /></div>
          <div>
            <label>Interest</label>
            <select value={form.service_interest} onChange={(e) => setForm({ ...form, service_interest: e.target.value })}>
              <option value="hotspot">Hotspot</option><option value="pppoe">PPPoE</option>
              <option value="ftth_gpon">FTTH/GPON</option><option value="static">Static</option>
            </select>
          </div>
          <div>
            <label>Source</label>
            <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="walk-in">Walk-in</option><option value="website">Website</option>
              <option value="whatsapp">WhatsApp</option><option value="sales">Sales</option><option value="referral">Referral</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div><label>Landmark</label><input value={form.landmark} onChange={(e) => setForm({ ...form, landmark: e.target.value })} placeholder="Near…" /></div>
          <div style={{ flex: 2 }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <button className="ghost" onClick={useGps} style={{ fontSize: 12 }}>
              {form.latitude != null ? `📍 ${form.latitude.toFixed(4)}, ${form.longitude!.toFixed(4)}` : '📍 Use my GPS'}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={addLead} disabled={adding}>{adding ? 'Adding…' : 'Add lead'}</button>
        </div>
      </div>

      {/* Table */}
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Interest</th><th>Stage</th><th>Pin</th><th>Actions</th></tr></thead>
        <tbody>
          {leads.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No leads yet.</td></tr>}
          {leads.map((l) => (
            <tr key={l.id}>
              <td>{l.name}{l.landmark ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>{l.landmark}</div> : null}</td>
              <td>{l.phone || '—'}</td>
              <td>{l.service_interest || '—'}</td>
              <td>
                <span className="badge" style={{ color: STAGE_COLOR[l.stage], borderColor: STAGE_COLOR[l.stage] }}>{STAGE_LABEL[l.stage]}</span>
              </td>
              <td>{l.latitude != null
                ? <span style={{ color: '#16a34a' }}>✓</span>
                : <button className="ghost" onClick={() => setGps(l.id)} style={{ padding: '2px 8px', fontSize: 11 }}>set</button>}</td>
              <td>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {l.stage !== 'active' && (
                    <select value="" onChange={(e) => e.target.value && move(l.id, e.target.value)} disabled={busy === l.id}
                      style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}>
                      <option value="">Move to…</option>
                      {MOVE_STAGES.filter((s) => s !== l.stage).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                    </select>
                  )}
                  {l.stage !== 'active' && l.stage !== 'lost' && (
                    <button onClick={() => convert(l.id)} disabled={busy === l.id} style={{ padding: '4px 10px', fontSize: 12 }}>Convert →</button>
                  )}
                  {l.converted_customer_id && <a href={`/customers/${l.converted_customer_id}`} style={{ fontSize: 12 }}>customer ↗</a>}
                  <button className="ghost" onClick={() => del(l.id)} disabled={busy === l.id} style={{ padding: '4px 8px', fontSize: 12, color: 'var(--red)' }}>✕</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
