'use client';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

interface Plan {
  id: string;
  name: string;
  type: 'prepaid' | 'postpaid' | 'hotspot';
  price_cents: number;
  currency: string;
  billing_cycle: string;
  validity_days: number;
  data_cap_mb: number | null;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
  active: boolean;
}

type TypeFilter = 'all' | Plan['type'];

const EMPTY_FORM = {
  name: '',
  type: 'hotspot' as Plan['type'],
  price: '',
  validity_days: '1',
  speed_down_mbps: '',
  speed_up_mbps: '',
  data_cap_mb: '',
};

export default function Plans() {
  const [list, setList] = useState<Plan[]>([]);
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [form, setForm] = useState(EMPTY_FORM);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Plan> | null>(null);

  const load = () =>
    api<Plan[]>('/plans?all=true').then(setList).catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      const payload: any = {
        name: form.name,
        type: form.type,
        price_cents: Math.round(Number(form.price) * 100),
        validity_days: Number(form.validity_days),
      };
      if (form.speed_down_mbps) payload.speed_down_kbps = Math.round(Number(form.speed_down_mbps) * 1000);
      if (form.speed_up_mbps) payload.speed_up_kbps = Math.round(Number(form.speed_up_mbps) * 1000);
      if (form.data_cap_mb) payload.data_cap_mb = Number(form.data_cap_mb);
      if (form.type === 'postpaid') payload.billing_cycle = 'monthly';
      await api('/plans', { method: 'POST', body: JSON.stringify(payload) });
      setToast({ ok: true, msg: `${labelType(form.type)} plan created` });
      setForm({ ...EMPTY_FORM, type: form.type });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const toggleActive = async (p: Plan) => {
    try {
      await api(`/plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ active: !p.active }) });
      setToast({ ok: true, msg: `${p.name} ${p.active ? 'deactivated' : 'activated'}` });
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const startEdit = (p: Plan) => {
    setEditingId(p.id);
    setEditForm({
      name: p.name,
      price_cents: p.price_cents,
      validity_days: p.validity_days,
      speed_down_kbps: p.speed_down_kbps,
      speed_up_kbps: p.speed_up_kbps,
      data_cap_mb: p.data_cap_mb,
    });
  };

  const saveEdit = async () => {
    if (!editingId || !editForm) return;
    try {
      await api(`/plans/${editingId}`, { method: 'PATCH', body: JSON.stringify(editForm) });
      setToast({ ok: true, msg: 'Plan updated' });
      setEditingId(null);
      setEditForm(null);
      load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };

  const filtered = list.filter((p) => filter === 'all' || p.type === filter);
  const counts = {
    all: list.length,
    hotspot: list.filter((p) => p.type === 'hotspot').length,
    prepaid: list.filter((p) => p.type === 'prepaid').length,
    postpaid: list.filter((p) => p.type === 'postpaid').length,
  };

  return (
    <div className="container">
      <h1>Plans &amp; Packages</h1>
      <p className="sub">
        Hotspot plans appear on the captive portal. Prepaid &amp; postpaid plans are
        used by PPPoE subscribers.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>New plan</h2>
        <div className="row">
          <div>
            <label>Type</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Plan['type'] })}>
              <option value="hotspot">Hotspot (captive portal)</option>
              <option value="prepaid">Prepaid (PPPoE)</option>
              <option value="postpaid">Postpaid (PPPoE, monthly)</option>
            </select>
          </div>
          <div>
            <label>Name</label>
            <input value={form.name} placeholder={form.type === 'hotspot' ? '1 Hour · 5 Mbps' : 'Home Fibre 20'} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label>Price (KES)</label>
            <input value={form.price} placeholder="20" onChange={(e) => setForm({ ...form, price: e.target.value })} inputMode="numeric" />
          </div>
          <div>
            <label>Validity ({form.type === 'hotspot' ? 'days' : 'days'})</label>
            <input value={form.validity_days} onChange={(e) => setForm({ ...form, validity_days: e.target.value })} inputMode="numeric" />
            {form.type === 'hotspot' && (
              <p className="sub" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
                For sub-day plans use a decimal (e.g. 0.04 = 1h, 0.25 = 6h)
              </p>
            )}
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <label>Speed down (Mbps)</label>
            <input value={form.speed_down_mbps} placeholder="5" onChange={(e) => setForm({ ...form, speed_down_mbps: e.target.value })} inputMode="decimal" />
          </div>
          <div>
            <label>Speed up (Mbps)</label>
            <input value={form.speed_up_mbps} placeholder="2" onChange={(e) => setForm({ ...form, speed_up_mbps: e.target.value })} inputMode="decimal" />
          </div>
          <div>
            <label>Data cap (MB, blank = ∞)</label>
            <input value={form.data_cap_mb} placeholder="5120" onChange={(e) => setForm({ ...form, data_cap_mb: e.target.value })} inputMode="numeric" />
          </div>
          <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <button disabled={!form.name || !form.price} onClick={create}>Create plan</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, margin: '20px 0 12px', flexWrap: 'wrap' }}>
        {(['all', 'hotspot', 'prepaid', 'postpaid'] as TypeFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={filter === f ? '' : 'ghost'}
            style={{ fontSize: 12 }}
          >
            {labelFilter(f)} <span style={{ opacity: 0.7 }}>· {counts[f]}</span>
          </button>
        ))}
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Price</th>
            <th>Validity</th>
            <th>Speed</th>
            <th>Data cap</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) =>
            editingId === p.id && editForm ? (
              <tr key={p.id}>
                <td><input value={editForm.name ?? ''} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></td>
                <td><span className={`badge ${p.type === 'hotspot' ? 'active' : ''}`}>{labelType(p.type)}</span></td>
                <td><input value={editForm.price_cents ? editForm.price_cents / 100 : ''} onChange={(e) => setEditForm({ ...editForm, price_cents: Math.round(Number(e.target.value) * 100) })} inputMode="numeric" /></td>
                <td><input value={editForm.validity_days ?? ''} onChange={(e) => setEditForm({ ...editForm, validity_days: Number(e.target.value) })} inputMode="numeric" style={{ width: 60 }} />d</td>
                <td>
                  <input value={editForm.speed_down_kbps ? editForm.speed_down_kbps / 1000 : ''} onChange={(e) => setEditForm({ ...editForm, speed_down_kbps: e.target.value ? Math.round(Number(e.target.value) * 1000) : null })} placeholder="↓ Mbps" inputMode="decimal" style={{ width: 70 }} />
                  /
                  <input value={editForm.speed_up_kbps ? editForm.speed_up_kbps / 1000 : ''} onChange={(e) => setEditForm({ ...editForm, speed_up_kbps: e.target.value ? Math.round(Number(e.target.value) * 1000) : null })} placeholder="↑ Mbps" inputMode="decimal" style={{ width: 70 }} />
                </td>
                <td><input value={editForm.data_cap_mb ?? ''} onChange={(e) => setEditForm({ ...editForm, data_cap_mb: e.target.value ? Number(e.target.value) : null })} inputMode="numeric" placeholder="∞" style={{ width: 80 }} /></td>
                <td>{p.active ? <span className="badge active">Active</span> : <span className="badge suspended">Inactive</span>}</td>
                <td>
                  <button onClick={saveEdit} style={{ fontSize: 11, padding: '4px 10px' }}>Save</button>{' '}
                  <button onClick={() => { setEditingId(null); setEditForm(null); }} className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}>Cancel</button>
                </td>
              </tr>
            ) : (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td><span className={`badge ${p.type === 'hotspot' ? 'active' : ''}`}>{labelType(p.type)}</span></td>
                <td>{money(p.price_cents, p.currency)}</td>
                <td>{p.validity_days}d</td>
                <td>{formatSpeed(p.speed_down_kbps, p.speed_up_kbps)}</td>
                <td>{p.data_cap_mb ? `${(p.data_cap_mb / 1024).toFixed(1)} GB` : '∞'}</td>
                <td>{p.active ? <span className="badge active">Active</span> : <span className="badge suspended">Inactive</span>}</td>
                <td>
                  <button onClick={() => startEdit(p)} className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}>Edit</button>{' '}
                  <button onClick={() => toggleActive(p)} className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}>{p.active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            )
          )}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={8} style={{ color: 'var(--muted)' }}>
                {filter === 'hotspot'
                  ? 'No hotspot plans yet — create one above and it will appear on the captive portal.'
                  : 'No plans match this filter.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function labelType(t: Plan['type']): string {
  return t === 'hotspot' ? 'Hotspot' : t === 'prepaid' ? 'Prepaid' : 'Postpaid';
}

function labelFilter(f: TypeFilter): string {
  return f === 'all' ? 'All' : labelType(f);
}

function formatSpeed(down: number | null, up: number | null): string {
  if (!down && !up) return '—';
  const d = down ? (down >= 1000 ? `${(down / 1000).toFixed(down % 1000 === 0 ? 0 : 1)}M` : `${down}k`) : '—';
  const u = up ? (up >= 1000 ? `${(up / 1000).toFixed(up % 1000 === 0 ? 0 : 1)}M` : `${up}k`) : '—';
  return `${d} / ${u}`;
}
