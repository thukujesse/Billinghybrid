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

interface DetectedRouter {
  board: string;
  version: string;
  hostname: string;
  defaultGateway: string;
  sshPort: number;
  interfaces: Array<{
    name: string;
    type: string;
    running: boolean;
    isWan: boolean;
    inBridge: string | null;
  }>;
}

interface WizardState {
  id: string;
  name: string;
  step: 'detect' | 'select' | 'applying' | 'done';
  detected: DetectedRouter | null;
  services: Set<'pppoe' | 'hotspot'>;
  pppoeIfaces: Set<string>;
  hotspotIfaces: Set<string>;
  hotspotNetwork: string;
  result: { stdout: string; stderr: string; success: boolean } | null;
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

  const testConnection = async (id: string) => {
    try {
      const r = await api<{ stdout: string; stderr: string; returncode: number }>(
        `/routers/${id}/exec`,
        { method: 'POST', body: JSON.stringify({ command: '/system/identity/print' }) }
      );
      if (r.returncode === 0) {
        setToast({ ok: true, msg: `Router responded: ${r.stdout.trim().slice(0, 100)}` });
      } else {
        setToast({ ok: false, msg: `exec failed: ${r.stderr.trim().slice(0, 200)}` });
      }
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    }
  };

  const [wizard, setWizard] = useState<WizardState | null>(null);

  const openConfigure = async (id: string, name: string) => {
    setWizard({
      id, name, step: 'detect', detected: null,
      services: new Set(), pppoeIfaces: new Set(), hotspotIfaces: new Set(),
      hotspotNetwork: '10.5.50.0/24', result: null,
    });
    try {
      const d = await api<DetectedRouter>(`/routers/${id}/detect`);
      setWizard((w) => w && { ...w, detected: d, step: 'select' });
    } catch (e: any) {
      setToast({ ok: false, msg: `Detect failed: ${e.message}` });
      setWizard(null);
    }
  };

  const applyConfig = async () => {
    if (!wizard) return;
    setWizard({ ...wizard, step: 'applying' });
    try {
      const services = Array.from(wizard.services);
      const r = await api<{ stdout: string; stderr: string; success: boolean }>(
        `/routers/${wizard.id}/configure`,
        {
          method: 'POST',
          body: JSON.stringify({
            services,
            pppoeInterfaces: services.includes('pppoe') ? Array.from(wizard.pppoeIfaces) : undefined,
            hotspotInterfaces: services.includes('hotspot') ? Array.from(wizard.hotspotIfaces) : undefined,
            hotspotNetwork: services.includes('hotspot') ? wizard.hotspotNetwork : undefined,
          }),
        }
      );
      setWizard({ ...wizard, step: 'done', result: r });
      if (r.success) setToast({ ok: true, msg: `Configured ${wizard.name}` });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
      setWizard({ ...wizard, step: 'select' });
    }
  };

  const togglePort = (kind: 'pppoeIfaces' | 'hotspotIfaces', name: string) => {
    setWizard((w) => {
      if (!w) return w;
      const next = new Set(w[kind]);
      next.has(name) ? next.delete(name) : next.add(name);
      return { ...w, [kind]: next };
    });
  };
  const toggleService = (s: 'pppoe' | 'hotspot') => {
    setWizard((w) => {
      if (!w) return w;
      const next = new Set(w.services);
      next.has(s) ? next.delete(s) : next.add(s);
      return { ...w, services: next };
    });
  };

  const deleteRouter = async (id: string, name: string) => {
    if (!confirm(`Delete ${name}? Releases its tunnel IP and removes the WG peer + RADIUS nas row. The MikroTik itself isn't touched (it'll just lose its tunnel until reprovisioned).`)) return;
    try {
      await api(`/routers/${id}`, { method: 'DELETE' });
      setToast({ ok: true, msg: `Deleted ${name}` });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    }
  };

  const reprovision = async (id: string, name: string) => {
    if (!confirm(`Reprovision ${name}? Rotates RADIUS secret + pushes fresh config to the MikroTik.`)) return;
    try {
      const r = await api<{
        autoApplied: boolean; autoApplyOutput: string; oneLiner: string;
        mikrotikScript: string; router: RouterRow;
      }>(`/routers/${id}/reprovision`, { method: 'POST' });
      if (r.autoApplied) {
        setToast({ ok: true, msg: `Reprovisioned ${name} — pushed via SSH, MikroTik self-applied` });
      } else {
        // Fall back: show the one-liner for manual paste via the success card.
        setResult({
          router: r.router, oneLiner: r.oneLiner,
          mikrotikScript: r.mikrotikScript, vpsAutoAdded: true,
        } as any);
        setToast({
          ok: false,
          msg: `SSH push failed (${r.autoApplyOutput.slice(0, 100)}). Paste the one-liner manually.`,
        });
      }
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.site ?? '—'}</td>
              <td><code>{r.wg_tunnel_ip ?? '—'}</code></td>
              <td><VpnPill status={r.vpn_status} /></td>
              <td title={r.last_handshake_at ?? ''}>{formatLastSeen(r.last_handshake_at)}</td>
              <td>
                <button
                  className="ghost"
                  style={{ fontSize: 11, padding: '4px 10px', marginRight: 4 }}
                  onClick={() => testConnection(r.id)}
                >
                  Test
                </button>
                <button
                  className="ghost"
                  style={{ fontSize: 11, padding: '4px 10px', marginRight: 4 }}
                  onClick={() => reprovision(r.id, r.name)}
                >
                  Reprovision
                </button>
                <button
                  className="ghost"
                  style={{ fontSize: 11, padding: '4px 10px', marginRight: 4 }}
                  onClick={() => openConfigure(r.id, r.name)}
                >
                  Configure
                </button>
                <button
                  className="ghost"
                  style={{ fontSize: 11, padding: '4px 10px', color: 'var(--red)' }}
                  onClick={() => deleteRouter(r.id, r.name)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No routers yet</td></tr>
          )}
        </tbody>
      </table>

      {wizard && (
        <ConfigureWizard
          wizard={wizard}
          onClose={() => setWizard(null)}
          onToggleService={toggleService}
          onTogglePort={togglePort}
          onCidrChange={(v) => setWizard((w) => w && { ...w, hotspotNetwork: v })}
          onApply={applyConfig}
        />
      )}
    </div>
  );
}

function ConfigureWizard(props: {
  wizard: WizardState;
  onClose: () => void;
  onToggleService: (s: 'pppoe' | 'hotspot') => void;
  onTogglePort: (kind: 'pppoeIfaces' | 'hotspotIfaces', name: string) => void;
  onCidrChange: (v: string) => void;
  onApply: () => void;
}) {
  const { wizard: w, onClose, onToggleService, onTogglePort, onCidrChange, onApply } = props;
  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
  };
  const panel: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: 8, padding: 24, maxWidth: 640, width: '90%',
    maxHeight: '85vh', overflow: 'auto',
  };
  const usablePorts = (w.detected?.interfaces ?? []).filter((i) => !i.isWan);
  const canApply =
    w.services.size > 0 &&
    (!w.services.has('pppoe') || w.pppoeIfaces.size > 0) &&
    (!w.services.has('hotspot') || (w.hotspotIfaces.size > 0 && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(w.hotspotNetwork)));

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Configure {w.name}</h2>

        {w.step === 'detect' && (
          <p className="sub">Detecting model + interfaces via the tunnel…</p>
        )}

        {w.step === 'select' && w.detected && (
          <>
            <p className="sub" style={{ marginBottom: 16 }}>
              <strong>{w.detected.board}</strong> · RouterOS {w.detected.version} ·
              hostname <code>{w.detected.hostname}</code> ·
              WAN: <code>{w.detected.defaultGateway || '—'}</code>
            </p>

            <h3 style={{ fontSize: 14, marginBottom: 8 }}>Select services</h3>
            <div className="row" style={{ marginBottom: 16 }}>
              <label style={{ flex: 1 }}>
                <input
                  type="checkbox"
                  checked={w.services.has('pppoe')}
                  onChange={() => onToggleService('pppoe')}
                /> PPPoE (subscribers)
              </label>
              <label style={{ flex: 1 }}>
                <input
                  type="checkbox"
                  checked={w.services.has('hotspot')}
                  onChange={() => onToggleService('hotspot')}
                /> Hotspot (captive portal)
              </label>
            </div>

            {w.services.has('pppoe') && (
              <PortPicker
                title="PPPoE ports"
                ports={usablePorts}
                selected={w.pppoeIfaces}
                otherSelected={w.hotspotIfaces}
                onToggle={(p) => onTogglePort('pppoeIfaces', p)}
              />
            )}

            {w.services.has('hotspot') && (
              <>
                <PortPicker
                  title="Hotspot ports"
                  ports={usablePorts}
                  selected={w.hotspotIfaces}
                  otherSelected={w.pppoeIfaces}
                  onToggle={(p) => onTogglePort('hotspotIfaces', p)}
                />
                <label>Hotspot network (CIDR)</label>
                <input
                  value={w.hotspotNetwork}
                  onChange={(e) => onCidrChange(e.target.value)}
                  placeholder="10.5.50.0/24"
                />
              </>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 24, justifyContent: 'flex-end' }}>
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button onClick={onApply} disabled={!canApply}>Complete configuration</button>
            </div>
          </>
        )}

        {w.step === 'applying' && (
          <p className="sub">Pushing config via tunnel SSH…</p>
        )}

        {w.step === 'done' && w.result && (
          <>
            <div className={`toast ${w.result.success ? 'ok' : 'err'}`}>
              {w.result.success ? '✓ Applied successfully' : '✗ Apply failed'}
            </div>
            <pre style={{
              background: 'var(--bg2,#0e1118)', padding: 10, borderRadius: 6,
              fontSize: 11, marginTop: 12, maxHeight: 300, overflow: 'auto',
            }}>{w.result.stdout || w.result.stderr || '(no output)'}</pre>
            <div style={{ textAlign: 'right', marginTop: 16 }}>
              <button onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PortPicker({
  title, ports, selected, otherSelected, onToggle,
}: {
  title: string;
  ports: DetectedRouter['interfaces'];
  selected: Set<string>;
  otherSelected: Set<string>;
  onToggle: (port: string) => void;
}) {
  return (
    <>
      <h4 style={{ fontSize: 13, marginTop: 12, marginBottom: 6 }}>{title}</h4>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
        {ports.length === 0 && <span className="sub">No usable ports detected.</span>}
        {ports.map((p) => {
          const isOther = otherSelected.has(p.name);
          return (
            <label
              key={p.name}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 10px', borderRadius: 4,
                background: selected.has(p.name) ? 'rgba(56,189,248,0.15)' : 'transparent',
                border: '1px solid var(--border)', cursor: isOther ? 'not-allowed' : 'pointer',
                opacity: isOther ? 0.4 : 1,
              }}
            >
              <input
                type="checkbox"
                disabled={isOther}
                checked={selected.has(p.name)}
                onChange={() => onToggle(p.name)}
              />
              <span style={{ fontFamily: 'ui-monospace', fontSize: 12 }}>
                {p.name}{' '}
                <span style={{ color: 'var(--muted)' }}>
                  {p.type}{p.running ? ' · up' : ' · down'}{p.inBridge ? ` · in ${p.inBridge}` : ''}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </>
  );
}

function VpnPill({ status }: { status: string }) {
  const cls =
    status === 'connected' ? 'online' :
    status === 'disconnected' ? 'offline' : 'pending';
  const label =
    status === 'connected' ? 'Online' :
    status === 'disconnected' ? 'Offline' : 'Waiting';
  return <span className={`vpn-pill ${cls}`}>{label}</span>;
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
