'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import type { MapData, Layers } from './TwinMap';

// Leaflet touches window on render — load the map client-only.
const TwinMap = dynamic(() => import('./TwinMap'), {
  ssr: false,
  loading: () => <div style={{ padding: 24, color: 'var(--muted)' }}>Loading map…</div>,
});

type Unlocated = { id: string; full_name: string; account_number: string; phone: string | null };
type Placement = { mode: 'site' } | { mode: 'device' } | { mode: 'customer'; id: string; name: string } | null;
type Pending = { lat: number; lng: number; kind: 'site' | 'device' } | null;

const LEGEND: Array<[string, string]> = [
  ['#16a34a', 'Online'], ['#d97706', 'Offline'], ['#dc2626', 'Suspended'],
  ['#2563eb', 'Site'], ['#7c3aed', 'OLT/Fibre'], ['#0891b2', 'Tower/AP'], ['#0d9488', 'FAT'],
];

export default function TwinPage() {
  const [data, setData] = useState<(MapData & { counts: { sites: number; devices: number; customers: number; online: number } }) | null>(null);
  const [unlocated, setUnlocated] = useState<Unlocated[]>([]);
  const [layers, setLayers] = useState<Layers>({ sites: true, devices: true, customers: true, links: true });
  const [placing, setPlacing] = useState<Placement>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [form, setForm] = useState({ name: '', type: 'pop', device_kind: 'olt', vendor: '' });
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const m = await api<MapData & { counts: any }>('/admin/network/twin/map');
      setData(m);
      setUnlocated(await api<Unlocated[]>('/admin/network/twin/unlocated-customers'));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const onMapClick = async (lat: number, lng: number) => {
    if (!placing) return;
    if (placing.mode === 'customer') {
      try {
        await api(`/admin/network/twin/customers/${placing.id}/location`, {
          method: 'PUT', body: JSON.stringify({ latitude: lat, longitude: lng }),
        });
        setPlacing(null); await load();
      } catch (e: any) { setErr(e.message); }
      return;
    }
    setPending({ lat, lng, kind: placing.mode });
  };

  const submitPending = async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'site') {
        if (!form.name.trim()) { setErr('Name required'); return; }
        await api('/admin/network/twin/sites', {
          method: 'POST',
          body: JSON.stringify({ name: form.name, type: form.type, latitude: pending.lat, longitude: pending.lng }),
        });
      } else {
        if (!form.name.trim()) { setErr('Name required'); return; }
        await api('/admin/network/twin/devices', {
          method: 'POST',
          body: JSON.stringify({ name: form.name, device_kind: form.device_kind, vendor: form.vendor || undefined, latitude: pending.lat, longitude: pending.lng }),
        });
      }
      setPending(null); setPlacing(null);
      setForm({ name: '', type: 'pop', device_kind: 'olt', vendor: '' });
      await load();
    } catch (e: any) { setErr(e.message); }
  };

  const onDelete = async (kind: 'site' | 'device' | 'customer', id: string) => {
    const path = kind === 'customer'
      ? `/admin/network/twin/customers/${id}/location`
      : `/admin/network/twin/${kind}s/${id}`;
    try { await api(path, { method: 'DELETE' }); await load(); } catch (e: any) { setErr(e.message); }
  };

  const c = data?.counts;
  const layerBtn = (key: keyof Layers, label: string) => (
    <button
      onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
      className={layers[key] ? '' : 'ghost'}
      style={{ padding: '5px 11px', fontSize: 12 }}
    >{label}</button>
  );

  return (
    <div style={{ padding: 20 }}>
      <h1>Live network map</h1>
      <p className="sub" style={{ marginBottom: 12 }}>
        Vendor-agnostic Network Twin — every located customer, site and device on one map.
        Customers are coloured by live RADIUS session.
      </p>
      {err && <div className="toast err">{err}</div>}

      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        {c && (
          <span style={{ fontSize: 13, color: 'var(--text-2)', marginRight: 8 }}>
            <strong>{c.customers}</strong> customers (<strong style={{ color: '#16a34a' }}>{c.online}</strong> online) ·{' '}
            <strong>{c.sites}</strong> sites · <strong>{c.devices}</strong> devices
          </span>
        )}
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {layerBtn('customers', 'Customers')}
          {layerBtn('devices', 'Devices')}
          {layerBtn('sites', 'Sites')}
          {layerBtn('links', 'Links')}
        </div>
        <button onClick={() => setPlacing(placing?.mode === 'site' ? null : { mode: 'site' })}
          className={placing?.mode === 'site' ? '' : 'ghost'} style={{ padding: '5px 11px', fontSize: 12 }}>+ Site</button>
        <button onClick={() => setPlacing(placing?.mode === 'device' ? null : { mode: 'device' })}
          className={placing?.mode === 'device' ? '' : 'ghost'} style={{ padding: '5px 11px', fontSize: 12 }}>+ Device</button>
      </div>

      {placing && (
        <div className="toast ok" style={{ marginTop: 0 }}>
          {placing.mode === 'customer'
            ? `Click the map to pin ${placing.name}.`
            : `Click the map to place a ${placing.mode}.`}{' '}
          <button onClick={() => setPlacing(null)} className="ghost" style={{ padding: '2px 8px', fontSize: 11, marginLeft: 8 }}>Cancel</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
        <div style={{ flex: 1, height: 'calc(100vh - 250px)', minHeight: 440, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
          {data
            ? <TwinMap data={data} layers={layers} placing={!!placing} onMapClick={onMapClick} onDelete={onDelete} />
            : <div style={{ padding: 24, color: 'var(--muted)' }}>Loading map…</div>}
        </div>

        {/* Side panel: legend + customers awaiting a pin */}
        <aside style={{ width: 270, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Legend</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 8px' }}>
              {LEGEND.map(([col, label]) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-2)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: col, flexShrink: 0 }} />{label}
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: 12, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Customers without a pin {unlocated.length ? `(${unlocated.length})` : ''}
            </div>
            <p className="sub" style={{ fontSize: 11, marginBottom: 8 }}>Click "Place", then click their location on the map.</p>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {unlocated.length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Everyone is mapped 🎉</span>}
              {unlocated.map((u) => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border-2)' }}>
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {u.full_name}<br /><span style={{ color: 'var(--muted)', fontSize: 11 }}>{u.account_number}</span>
                  </div>
                  <button onClick={() => setPlacing({ mode: 'customer', id: u.id, name: u.full_name })}
                    className={placing?.mode === 'customer' && placing.id === u.id ? '' : 'ghost'}
                    style={{ padding: '3px 9px', fontSize: 11 }}>Place</button>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {/* Place-site / place-device form */}
      {pending && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setPending(null)}>
          <div className="card" style={{ width: 360, maxWidth: '90%' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>New {pending.kind}</h3>
            <p className="sub" style={{ marginTop: 0 }}>at {pending.lat.toFixed(5)}, {pending.lng.toFixed(5)}</p>
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={pending.kind === 'site' ? 'e.g. Nakuru CBD POP' : 'e.g. OLT-Kiamunyi-1'} autoFocus />
            {pending.kind === 'site' ? (
              <>
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option value="pop">POP</option><option value="tower">Tower</option>
                  <option value="cabinet">Cabinet</option><option value="datacenter">Datacenter</option>
                  <option value="office">Office</option><option value="other">Other</option>
                </select>
              </>
            ) : (
              <>
                <label>Kind</label>
                <select value={form.device_kind} onChange={(e) => setForm({ ...form, device_kind: e.target.value })}>
                  <option value="olt">OLT</option><option value="fat">FAT</option><option value="splitter">Splitter</option>
                  <option value="tower">Tower</option><option value="ap_sector">AP / Sector</option>
                  <option value="pole">Pole</option><option value="switch">Switch</option>
                  <option value="router">Router</option><option value="backhaul">Backhaul</option>
                </select>
                <label>Vendor (optional)</label>
                <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="hios / huawei / zte / mikrotik …" />
              </>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={submitPending}>Save</button>
              <button className="ghost" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
