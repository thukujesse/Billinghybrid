'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface RouterRow {
  id: string;
  name: string;
  host: string;
  site: string | null;
  status: string;
  vpn_status: string;
  wg_tunnel_ip: string | null;
  last_handshake_at: string | null;
}

interface ProvisionResult {
  router: RouterRow;
  mikrotikScript: string;
  vpsAddCommand: string;
}

export default function Routers() {
  const [list, setList] = useState<RouterRow[]>([]);
  const [form, setForm] = useState({ name: '', site: '' });
  const [provisioning, setProvisioning] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () =>
    api<RouterRow[]>('/routers')
      .then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));
  useEffect(() => { load(); }, []);

  const provision = async () => {
    setProvisioning(true);
    setResult(null);
    try {
      const r = await api<ProvisionResult>('/routers/provision', {
        method: 'POST',
        body: JSON.stringify({ name: form.name, site: form.site || undefined }),
      });
      setResult(r);
      setForm({ name: '', site: '' });
      setToast({ ok: true, msg: `Provisioned ${r.router.name} at ${r.router.wg_tunnel_ip}` });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setProvisioning(false);
    }
  };

  const copy = async (text: string) => {
    const ok = await copyToClipboard(text);
    setToast(
      ok
        ? { ok: true, msg: 'Copied to clipboard' }
        : { ok: false, msg: 'Copy failed — select text manually with Ctrl+A then Ctrl+C' }
    );
  };

  return (
    <div className="container">
      <h1>Router Registry</h1>
      <p className="sub">
        Zero-touch MikroTik provisioning. Enter a name + site, then paste the
        generated script onto the router and the wg command on the VPS.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Provision new router</h3>
        <div className="row">
          <div>
            <label>Name</label>
            <input
              value={form.name}
              placeholder="e.g. main-router"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label>Site (optional)</label>
            <input
              value={form.site}
              placeholder="e.g. Kasarani"
              onChange={(e) => setForm({ ...form, site: e.target.value })}
            />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button disabled={!form.name || provisioning} onClick={provision}>
              {provisioning ? 'Provisioning…' : 'Provision'}
            </button>
          </div>
        </div>
      </div>

      {result && (
        <div className="card" style={{ borderColor: 'var(--ok)' }}>
          <h3 style={{ marginTop: 0 }}>
            ✓ Router provisioned — tunnel IP <code>{result.router.wg_tunnel_ip}</code>
          </h3>
          <p className="sub" style={{ marginTop: 4 }}>
            Two manual steps. The router's status will flip from “pending” to
            “connected” once it dials in (heartbeat coming in slice 2).
          </p>

          <h4>1. Run this on the VPS (adds the peer to wg0)</h4>
          <ScriptBlock text={result.vpsAddCommand} onCopy={copy} />

          <h4>2. Paste this into the MikroTik (RouterOS 7.x terminal)</h4>
          <ScriptBlock text={result.mikrotikScript} onCopy={copy} />
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Site</th>
            <th>Tunnel IP</th>
            <th>VPN</th>
            <th>Last handshake</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.site ?? '—'}</td>
              <td><code>{r.wg_tunnel_ip ?? '—'}</code></td>
              <td>
                <span
                  className={`badge ${
                    r.vpn_status === 'connected'
                      ? 'active'
                      : r.vpn_status === 'disconnected'
                      ? 'suspended'
                      : 'pending'
                  }`}
                >
                  {r.vpn_status}
                </span>
              </td>
              <td>{r.last_handshake_at ? new Date(r.last_handshake_at).toLocaleString() : '—'}</td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No routers yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function ScriptBlock({ text, onCopy }: { text: string; onCopy: (s: string) => void }) {
  return (
    <div style={{ position: 'relative', marginTop: 8 }}>
      <pre
        style={{
          background: 'var(--bg2, #0e1118)',
          padding: 12,
          borderRadius: 6,
          overflowX: 'auto',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <code>{text}</code>
      </pre>
      <button
        onClick={() => onCopy(text)}
        style={{ position: 'absolute', top: 8, right: 8, fontSize: 12 }}
      >
        Copy
      </button>
    </div>
  );
}
