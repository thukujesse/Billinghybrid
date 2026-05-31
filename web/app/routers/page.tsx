'use client';
import { useEffect, useRef, useState } from 'react';
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
  oneLiner: string;
  mikrotikScript: string;
  vpsAddCommand?: string;
  vpsAutoAdded: boolean;
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
  useEffect(() => {
    load();
    // Poll every 10s so VPN status flips from 'pending' to 'connected' live
    // (api itself polls the VPS wg-manager every 30s in the background).
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

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

  const copy = async (text: string, preEl: HTMLElement | null) => {
    const result = await copyToClipboard(text, preEl);
    if (result === 'copied') setToast({ ok: true, msg: 'Copied to clipboard' });
    else if (result === 'selected') setToast({ ok: true, msg: 'Text selected — press Ctrl+C to copy' });
    else setToast({ ok: false, msg: 'Could not copy. Click the box and use Ctrl+A then Ctrl+C.' });
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
          {result.vpsAutoAdded ? (
            <p className="sub" style={{ marginTop: 4 }}>
              ✓ Peer added to VPS automatically. Paste ONE line on the MikroTik below.
            </p>
          ) : (
            <p className="sub" style={{ marginTop: 4 }}>
              ⚠ wg-manager not configured on API — falling back to manual VPS paste.
            </p>
          )}

          {!result.vpsAutoAdded && result.vpsAddCommand && (
            <>
              <h4>1. Run this on the VPS (adds the peer to wg0)</h4>
              <ScriptBlock text={result.vpsAddCommand} onCopy={copy} />
              <h4>2. Paste this one-liner into the MikroTik (RouterOS 7.x)</h4>
            </>
          )}
          {result.vpsAutoAdded && (
            <h4>
              {result.oneLiner
                ? 'Paste this one-liner into the MikroTik (RouterOS 7.x)'
                : 'Paste this script into the MikroTik (use /import or paste atomically)'}
            </h4>
          )}
          {result.oneLiner ? (
            <>
              <ScriptBlock text={result.oneLiner} onCopy={copy} />
              <p className="sub" style={{ marginTop: 8 }}>
                The token in the URL is single-use and expires in 24 hours.
                MikroTik will fetch the full WireGuard config + import it.
              </p>
              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
                  Show full script (for manual paste or audit)
                </summary>
                <div style={{ marginTop: 8 }}>
                  <ScriptBlock text={result.mikrotikScript} onCopy={copy} />
                </div>
              </details>
            </>
          ) : (
            <ScriptBlock text={result.mikrotikScript} onCopy={copy} />
          )}
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
              <td title={r.last_handshake_at ?? ''}>{formatLastSeen(r.last_handshake_at)}</td>
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

function formatLastSeen(iso: string | null): string {
  if (!iso) return '—';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

type CopyResult = 'copied' | 'selected' | 'failed';

async function copyToClipboard(text: string, preEl: HTMLElement | null): Promise<CopyResult> {
  // Tier 1: modern Clipboard API (HTTPS + user gesture + permission).
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      // fall through
    }
  }
  // Tier 2: legacy execCommand via off-screen textarea.
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
    if (ok) return 'copied';
  } catch {
    // fall through
  }
  // Tier 3: select the visible text so the user can press Ctrl+C themselves.
  if (preEl) {
    try {
      const range = document.createRange();
      range.selectNodeContents(preEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return 'selected';
    } catch {
      // fall through
    }
  }
  return 'failed';
}

function ScriptBlock({
  text,
  onCopy,
}: {
  text: string;
  onCopy: (s: string, preEl: HTMLElement | null) => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const selectAll = () => {
    const el = preRef.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  return (
    <div style={{ position: 'relative', marginTop: 8 }}>
      <pre
        ref={preRef}
        onClick={selectAll}
        title="Click anywhere to select all"
        style={{
          background: 'var(--bg2, #0e1118)',
          padding: 12,
          borderRadius: 6,
          overflowX: 'auto',
          fontSize: 12,
          lineHeight: 1.5,
          cursor: 'pointer',
          userSelect: 'all',
        }}
      >
        <code>{text}</code>
      </pre>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCopy(text, preRef.current);
        }}
        style={{ position: 'absolute', top: 8, right: 8, fontSize: 12 }}
      >
        Copy
      </button>
    </div>
  );
}
