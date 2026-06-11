'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Tpl {
  event_key: string; audience: 'hotspot' | 'pppoe';
  label: string; description: string; placeholders: string[];
  body: string; enabled: boolean; is_custom: boolean;
}

const SAMPLE: Record<string, string> = {
  brand: 'HUB Networks', first_name: 'Jeff', username: 'jeff254', password: 'a1b2c3',
  portal_url: 'hubnetwifi.co.ke/portal', amount: '50', balance: '120', receipt: ' Receipt: SGH7XQ.',
  service: 'Home Fibre 10', expiry: '15 Jun 18:00', price: '250', days: '2', shortfall: '130',
  plan: 'Home 20Mbps', rate: ' (20M/20M)', package: '1 Hour',
};
const fillSample = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => SAMPLE[k] ?? `{${k}}`);

export default function MessagesPage() {
  const [list, setList] = useState<Tpl[]>([]);
  const [audience, setAudience] = useState<'pppoe' | 'hotspot'>('pppoe');
  const [drafts, setDrafts] = useState<Record<string, { body: string; enabled: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const key = (t: Tpl) => `${t.event_key}:${t.audience}`;
  const ingest = (l: Tpl[]) => {
    setList(l);
    setDrafts((prev) => {
      const d = { ...prev };
      l.forEach((t) => { d[`${t.event_key}:${t.audience}`] = { body: t.body, enabled: t.enabled }; });
      return d;
    });
  };
  const load = async () => { try { ingest(await api<Tpl[]>('/admin/message-templates')); } catch (e: any) { setToast({ ok: false, msg: e.message }); } };
  useEffect(() => { load(); }, []);

  const save = async (t: Tpl) => {
    const k = key(t); const d = drafts[k]; setBusy(k);
    try {
      ingest(await api<Tpl[]>(`/admin/message-templates/${t.event_key}/${t.audience}`, { method: 'PUT', body: JSON.stringify({ body: d.body, enabled: d.enabled }) }));
      setToast({ ok: true, msg: `${t.label} saved` });
    } catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setBusy(null); }
  };
  const reset = async (t: Tpl) => {
    const k = key(t); setBusy(k);
    try { ingest(await api<Tpl[]>(`/admin/message-templates/${t.event_key}/${t.audience}/reset`, { method: 'POST' })); setToast({ ok: true, msg: `${t.label} reset to default` }); }
    catch (e: any) { setToast({ ok: false, msg: e.message }); } finally { setBusy(null); }
  };

  const shown = list.filter((t) => t.audience === audience);
  return (
    <div className="container">
      <h1>Message templates</h1>
      <p className="sub">
        Customize the SMS sent to customers — with separate wording for <strong>hotspot</strong> guests and{' '}
        <strong>PPPoE</strong> subscribers. Tap a placeholder chip to insert it; turn a template <strong>Off</strong> to skip that message.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {(['pppoe', 'hotspot'] as const).map((a) => (
          <button key={a} onClick={() => setAudience(a)} className={audience === a ? '' : 'ghost'}>
            {a === 'pppoe' ? 'PPPoE' : 'Hotspot'} <span style={{ opacity: 0.7 }}>· {list.filter((t) => t.audience === a).length}</span>
          </button>
        ))}
      </div>

      {shown.map((t) => {
        const k = key(t); const d = drafts[k] ?? { body: t.body, enabled: t.enabled };
        return (
          <div key={k} className="card" style={{ marginBottom: 14, opacity: d.enabled ? 1 : 0.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 15 }}>
                  {t.label} {t.is_custom && <span className="badge" style={{ color: 'var(--accent)', borderColor: 'var(--accent)', fontSize: 10 }}>custom</span>}
                </h3>
                <p className="sub" style={{ marginTop: 2, marginBottom: 0 }}>{t.description}</p>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={d.enabled} onChange={(e) => setDrafts((s) => ({ ...s, [k]: { ...d, enabled: e.target.checked } }))} style={{ width: 'auto' }} /> {d.enabled ? 'On' : 'Off'}
              </label>
            </div>
            <textarea value={d.body} onChange={(e) => setDrafts((s) => ({ ...s, [k]: { ...d, body: e.target.value } }))} rows={3}
              style={{ marginTop: 10, fontFamily: 'inherit', resize: 'vertical' }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              {t.placeholders.map((p) => (
                <button key={p} type="button" onClick={() => setDrafts((s) => ({ ...s, [k]: { ...d, body: d.body + `{${p}}` } }))}
                  style={{ fontSize: 11, padding: '2px 8px', background: 'var(--card-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 999, cursor: 'pointer' }}>{`{${p}}`}</button>
              ))}
            </div>
            <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--card-2)', borderRadius: 8, fontSize: 13, color: 'var(--text-2)' }}>
              <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Preview</span>
              <div>{fillSample(d.body)}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => save(t)} disabled={busy === k}>{busy === k ? 'Saving…' : 'Save'}</button>
              {t.is_custom && <button className="ghost" onClick={() => reset(t)} disabled={busy === k}>Reset to default</button>}
            </div>
          </div>
        );
      })}
      {shown.length === 0 && <p className="sub">No templates for this audience yet.</p>}
    </div>
  );
}
