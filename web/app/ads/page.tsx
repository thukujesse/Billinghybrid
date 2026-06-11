'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Ad {
  id: string; title: string; media_type: 'image' | 'video'; media_url: string;
  link_url: string | null; placement: string; target_router_id: string | null;
  weight: number; starts_at: string | null; ends_at: string | null; active: boolean;
  impressions: number; clicks: number;
}
interface RouterLite { id: string; name: string }

const PLACEMENTS: Array<[string, string]> = [
  ['portal_banner', 'Captive-portal banner'],
  ['post_payment', 'After payment (video)'],
  ['dashboard', 'Customer dashboard'],
];
const placeLabel = (p: string) => PLACEMENTS.find(([v]) => v === p)?.[1] ?? p;

const EMPTY = {
  title: '', media_type: 'image' as 'image' | 'video', media_url: '', link_url: '',
  placement: 'portal_banner', target_router_id: '', weight: '1', starts_at: '', ends_at: '',
};

export default function AdsPage() {
  const [list, setList] = useState<Ad[]>([]);
  const [routers, setRouters] = useState<RouterLite[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = async () => {
    try {
      setList(await api<Ad[]>('/admin/ads'));
      setRouters((await api<RouterLite[]>('/routers')).map((r) => ({ id: r.id, name: r.name })));
    } catch (e: any) { setToast({ ok: false, msg: e.message }); }
  };
  useEffect(() => { load(); }, []);

  const onImage = (file: File | null) => {
    if (!file) return;
    if (file.size > 1_200_000) { setToast({ ok: false, msg: 'Image too large — keep it under ~1 MB.' }); return; }
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, media_url: String(reader.result) }));
    reader.readAsDataURL(file);
  };

  // Videos are too big for a DB data URL — upload the file to storage and keep
  // the returned served URL on the ad.
  const onVideo = async (file: File | null) => {
    if (!file) return;
    if (file.size > 9_000_000) { setToast({ ok: false, msg: 'Video too large — keep sponsor clips under ~9 MB (3–5s is ideal).' }); return; }
    setUploading(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const { url } = await api<{ url: string }>('/admin/ads/upload', { method: 'POST', body: JSON.stringify({ dataUrl }) });
      setForm((f) => ({ ...f, media_url: url }));
      setToast({ ok: true, msg: 'Video uploaded' });
    } catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setUploading(false); }
  };

  const create = async () => {
    if (!form.title.trim() || !form.media_url.trim()) {
      setToast({ ok: false, msg: 'Title and media (image or video URL) are required.' }); return;
    }
    setSaving(true);
    try {
      await api('/admin/ads', { method: 'POST', body: JSON.stringify({
        title: form.title,
        media_type: form.media_type,
        media_url: form.media_url,
        link_url: form.link_url || undefined,
        placement: form.placement,
        target_router_id: form.target_router_id || null,
        weight: Number(form.weight) || 1,
        starts_at: form.starts_at || null,
        ends_at: form.ends_at || null,
      }) });
      setForm(EMPTY);
      setToast({ ok: true, msg: 'Ad created' });
      await load();
    } catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setSaving(false); }
  };

  const toggle = async (ad: Ad) => {
    setBusy(ad.id);
    try { await api(`/admin/ads/${ad.id}`, { method: 'PATCH', body: JSON.stringify({ active: !ad.active }) }); await load(); }
    catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setBusy(null); }
  };
  const del = async (id: string) => {
    setBusy(id);
    try { await api(`/admin/ads/${id}`, { method: 'DELETE' }); await load(); }
    catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setBusy(null); }
  };

  const routerName = (id: string | null) => id ? (routers.find((r) => r.id === id)?.name ?? 'router') : 'All routers';
  const ctr = (a: Ad) => a.impressions > 0 ? `${((a.clicks / a.impressions) * 100).toFixed(1)}%` : '—';

  return (
    <div className="container">
      <h1>Advertisements</h1>
      <p className="sub">Sponsor banners + promos on the captive portal — a revenue stream and a way to push your own packages. Target by router, schedule, and track views/clicks.</p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      {/* Create */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>New ad</h2>
        <div className="row">
          <div style={{ flex: 2 }}><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Nakuru Pizza — 10% off" /></div>
          <div>
            <label>Media type</label>
            <select value={form.media_type} onChange={(e) => setForm({ ...form, media_type: e.target.value as 'image' | 'video', media_url: '' })}>
              <option value="image">Image</option><option value="video">Video (URL)</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div style={{ flex: 2 }}>
            <label>{form.media_type === 'image' ? 'Image (under ~1 MB)' : 'Video (upload ≤ ~9 MB, or paste a URL)'}</label>
            {form.media_type === 'image' ? (
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => onImage(e.target.files?.[0] ?? null)} style={{ width: 'auto' }} />
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => onVideo(e.target.files?.[0] ?? null)} style={{ width: 'auto' }} disabled={uploading} />
                  {uploading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>Uploading…</span>}
                </div>
                <input value={form.media_url} onChange={(e) => setForm({ ...form, media_url: e.target.value })} placeholder="…or paste a hosted video URL" style={{ marginTop: 6 }} />
              </>
            )}
          </div>
          <div style={{ flex: 2 }}><label>Click link (optional)</label><input value={form.link_url} onChange={(e) => setForm({ ...form, link_url: e.target.value })} placeholder="https://…" /></div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <label>Placement</label>
            <select value={form.placement} onChange={(e) => setForm({ ...form, placement: e.target.value })}>
              {PLACEMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label>Target</label>
            <select value={form.target_router_id} onChange={(e) => setForm({ ...form, target_router_id: e.target.value })}>
              <option value="">All routers</option>
              {routers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 90px' }}><label>Weight</label><input value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} inputMode="numeric" /></div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div><label>Start (optional)</label><input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></div>
          <div><label>End (optional)</label><input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></div>
          <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}><button onClick={create} disabled={saving}>{saving ? 'Saving…' : 'Create ad'}</button></div>
        </div>
        {form.media_url && (
          <div style={{ marginTop: 12 }}>
            <label>Preview</label>
            {form.media_type === 'video'
              ? <video src={form.media_url} muted loop autoPlay playsInline style={{ maxWidth: 320, maxHeight: 120, borderRadius: 8, border: '1px solid var(--border)' }} />
              /* eslint-disable-next-line @next/next/no-img-element */
              : <img src={form.media_url} alt="" style={{ maxWidth: 320, maxHeight: 120, borderRadius: 8, border: '1px solid var(--border)', objectFit: 'cover' }} />}
          </div>
        )}
      </div>

      {/* List */}
      <table>
        <thead><tr><th>Ad</th><th>Placement</th><th>Target</th><th>Schedule</th><th>Views · Clicks · CTR</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>No ads yet.</td></tr>}
          {list.map((a) => (
            <tr key={a.id}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {a.media_type === 'video'
                    ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>▶ video</span>
                    /* eslint-disable-next-line @next/next/no-img-element */
                    : <img src={a.media_url} alt="" style={{ width: 56, height: 34, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }} />}
                  <div>{a.title}{a.link_url && <div style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.link_url}</div>}</div>
                </div>
              </td>
              <td style={{ fontSize: 12 }}>{placeLabel(a.placement)}</td>
              <td style={{ fontSize: 12 }}>{routerName(a.target_router_id)}</td>
              <td style={{ fontSize: 11, color: 'var(--muted)' }}>
                {a.starts_at ? new Date(a.starts_at).toLocaleDateString() : 'now'} → {a.ends_at ? new Date(a.ends_at).toLocaleDateString() : '∞'}
              </td>
              <td style={{ fontSize: 12 }}><strong>{a.impressions}</strong> · <strong>{a.clicks}</strong> · {ctr(a)}</td>
              <td><span className={`badge ${a.active ? 'active' : 'suspended'}`}>{a.active ? 'Live' : 'Off'}</span></td>
              <td>
                <button className="ghost" onClick={() => toggle(a)} disabled={busy === a.id} style={{ fontSize: 11, padding: '4px 10px' }}>{a.active ? 'Disable' : 'Enable'}</button>{' '}
                <button className="ghost" onClick={() => del(a.id)} disabled={busy === a.id} style={{ fontSize: 11, padding: '4px 10px', color: 'var(--red)' }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
