'use client';
/**
 * Captive-portal diagnostics — operator timeline for "I paid but no internet"
 * support calls. Search by MAC or M-Pesa phone and read the chronological
 * trace of every portal touchpoint: STK pushes, voucher attempts, auto-grant
 * tier failures, rebind OTPs, grant issues.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';

interface TraceRow {
  source: 'portal_event' | 'auto_reconnect';
  id: string;
  created_at: string;
  event_type: string;
  mac: string | null;
  phone: string | null;
  success: boolean | null;
  reason: string | null;
  detail: Record<string, unknown>;
  source_ip: string | null;
  user_agent: string | null;
  router_id: string | null;
  tenant: string | null;
}

interface Summary {
  windowHours: number;
  total: number;
  byType: Record<string, number>;
  successRate: number | null;
  stkSuccessRate: number | null;
  uniqueMacs: number;
  uniquePhones: number;
}

const EVENT_LABEL: Record<string, string> = {
  portal_load: 'Portal load',
  quick_connect: 'Quick connect',
  voucher_redeem: 'Voucher redeem',
  stk_init: 'STK push sent',
  stk_callback: 'STK callback',
  stk_status_flip: 'Status flip',
  rebind_start: 'Rebind OTP sent',
  rebind_verify: 'Rebind OTP verified',
  grant_issued: 'Grant issued',
  token_mint: 'Device token minted',
  token_revoke: 'Device token revoked',
  forget_device: 'Device forgotten',
  lookup_miss: 'MAC lookup miss',
  erase_start: 'Erase requested',
  erase_verify: 'Erase confirmed',
  // auto_reconnect_log composites — "method.outcome"
  'mac.success': 'Auto-grant (MAC) ✓',
  'mac.no_match': 'Auto-grant (MAC) miss',
  'token.success': 'Auto-grant (token) ✓',
  'token.no_match': 'Auto-grant (token) miss',
  'token.expired': 'Auto-grant (token) expired',
  'token.revoked': 'Auto-grant (token) revoked',
  'token.grant_expired': 'Auto-grant (token) grant lapsed',
  'fingerprint.success': 'Auto-grant (fingerprint) ✓',
  'fingerprint.no_match': 'Auto-grant (fingerprint) miss',
  'fingerprint.grant_expired': 'Auto-grant (fingerprint) grant lapsed',
  'manual.success': 'Manual auth ✓',
  'manual.no_match': 'Manual auth miss',
};

const labelFor = (t: string) => EVENT_LABEL[t] ?? t;

function relativeTime(iso: string): string {
  const past = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.round(past / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function dotStyle(success: boolean | null): React.CSSProperties {
  if (success === true)  return { background: '#16a34a' };
  if (success === false) return { background: '#dc2626' };
  return { background: '#94a3b8' };
}

function deviceFromUa(ua: string | null): string {
  if (!ua) return '—';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) {
    const m = /;\s*([^;)]+?)\s+Build\//i.exec(ua);
    return m ? `Android · ${m[1].trim()}` : 'Android';
  }
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'Other';
}

export default function DiagnosticsPage() {
  const [searchType, setSearchType] = useState<'mac' | 'phone'>('mac');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Top-of-page rollup card — fires once on mount + every 60s.
  useEffect(() => {
    const load = () => api<Summary>('/admin/diagnostics/summary?hours=24').then(setSummary).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // Deep-link support: /diagnostics?mac=... or ?phone=... auto-runs the
  // search on mount. Lets the "Trace" button on the hotspot users page
  // jump straight to a result. Inline the fetch instead of calling
  // runSearch() to avoid an extra render between setQuery and search.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const m = q.get('mac');
    const p = q.get('phone');
    const which = m ? 'mac' : (p ? 'phone' : null);
    const val = m ?? p;
    if (!which || !val) return;
    setSearchType(which);
    setQuery(val);
    setLoading(true);
    api<{ rows: TraceRow[] }>(`/admin/diagnostics/trace?${which}=${encodeURIComponent(val)}&limit=500`)
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api<{ rows: TraceRow[] }>(
        `/admin/diagnostics/trace?${searchType}=${encodeURIComponent(q)}&limit=500`
      );
      setRows(r.rows);
    } catch (e: any) {
      setErr(e.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const grouped = useMemo(() => {
    // Group rows by calendar day for readability — long traces span weeks.
    const buckets: { day: string; rows: TraceRow[] }[] = [];
    for (const r of rows) {
      const day = new Date(r.created_at).toLocaleDateString();
      const last = buckets[buckets.length - 1];
      if (last && last.day === day) last.rows.push(r);
      else buckets.push({ day, rows: [r] });
    }
    return buckets;
  }, [rows]);

  return (
    <main style={{ padding: 24, fontFamily: 'Inter, system-ui, sans-serif', color: '#0f172a', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Captive-portal diagnostics</h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0 0' }}>
          Chronological trace of every portal touchpoint for a device or phone.
          Use this when a customer says &ldquo;I paid but no internet&rdquo; — the timeline shows where the flow broke.
        </p>
      </header>

      {summary && (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          <Kpi label="Events (24h)" value={summary.total.toLocaleString()} />
          <Kpi label="Success rate" value={summary.successRate == null ? '—' : `${summary.successRate}%`} />
          <Kpi label="STK success" value={summary.stkSuccessRate == null ? '—' : `${summary.stkSuccessRate}%`} />
          <Kpi label="Unique MACs / phones" value={`${summary.uniqueMacs} / ${summary.uniquePhones}`} />
        </section>
      )}

      <form onSubmit={runSearch} style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        <div style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 8, padding: 4 }}>
          {(['mac', 'phone'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSearchType(t)}
              style={{
                padding: '6px 14px',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                background: searchType === t ? '#fff' : 'transparent',
                color: searchType === t ? '#0f172a' : '#64748b',
                boxShadow: searchType === t ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              {t === 'mac' ? 'MAC' : 'Phone'}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchType === 'mac' ? 'aa:bb:cc:dd:ee:ff' : '07XX XXX XXX or 2547XX'}
          style={{
            flex: 1, padding: '10px 14px', fontSize: 14, border: '1px solid #e2e8f0',
            borderRadius: 8, outline: 'none', fontFamily: searchType === 'mac' ? 'ui-monospace, monospace' : 'inherit',
          }}
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          style={{
            padding: '10px 20px', background: '#2563eb', color: '#fff', border: 'none',
            borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: loading ? 'wait' : 'pointer',
            opacity: !query.trim() ? 0.5 : 1,
          }}
        >
          {loading ? 'Searching…' : 'Trace'}
        </button>
      </form>

      {err && (
        <div style={{ background: 'rgba(220,38,38,0.08)', color: '#b91c1c', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {err}
        </div>
      )}

      {!loading && rows.length === 0 && query.trim() && !err && (
        <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
          No events for this {searchType}. Either no activity in the retention window, or check the format.
        </div>
      )}

      {grouped.map((bucket) => (
        <section key={bucket.day} style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
            {bucket.day} <span style={{ fontWeight: 400 }}>· {bucket.rows.length} events</span>
          </h3>
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
            {bucket.rows.map((r, i) => {
              const expanded = expandedId === r.source + ':' + r.id;
              const hasDetail = Object.keys(r.detail ?? {}).length > 0;
              return (
                <div
                  key={r.source + ':' + r.id}
                  style={{
                    padding: '12px 16px',
                    borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
                    cursor: hasDetail ? 'pointer' : 'default',
                  }}
                  onClick={() => hasDetail && setExpandedId(expanded ? null : r.source + ':' + r.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ ...dotStyle(r.success), width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }} />
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{labelFor(r.event_type)}</span>
                    {r.reason && (
                      <span style={{ fontSize: 12, color: '#b91c1c', background: 'rgba(220,38,38,0.08)', padding: '2px 8px', borderRadius: 4 }}>
                        {r.reason}
                      </span>
                    )}
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#64748b' }}>
                      {r.phone && <code style={{ fontFamily: 'ui-monospace, monospace' }}>{r.phone}</code>}
                      {r.mac && <code style={{ fontFamily: 'ui-monospace, monospace' }}>{r.mac}</code>}
                      <span title={new Date(r.created_at).toLocaleString()}>{relativeTime(r.created_at)}</span>
                      {hasDetail && <span style={{ color: '#94a3b8', fontSize: 14 }}>{expanded ? '▾' : '▸'}</span>}
                    </div>
                  </div>
                  {expanded && hasDetail && (
                    <div style={{ marginTop: 10, marginLeft: 20, padding: 12, background: '#f8fafc', borderRadius: 6, fontSize: 12 }}>
                      <pre style={{ margin: 0, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#334155' }}>
                        {JSON.stringify(r.detail, null, 2)}
                      </pre>
                      <div style={{ marginTop: 8, color: '#94a3b8', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        {r.source_ip && <span>IP <code>{r.source_ip}</code></span>}
                        {r.user_agent && <span>{deviceFromUa(r.user_agent)}</span>}
                        {r.tenant && <span>tenant <code>{r.tenant}</code></span>}
                        <span style={{ marginLeft: 'auto' }}>source: {r.source}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}
