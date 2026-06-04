'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface AuditEntry {
  id: string;
  created_at: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  actor_id: string;
  actor_label: string;
  actor_role: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

const KIND_COLORS: Record<string, { bg: string; fg: string }> = {
  'customer.create':       { bg: 'rgba(22,163,74,0.10)', fg: '#15803d' },
  'customer.update':       { bg: 'rgba(37,99,235,0.10)', fg: '#1d4ed8' },
  'service.create':        { bg: 'rgba(22,163,74,0.10)', fg: '#15803d' },
  'service.status_change': { bg: 'rgba(217,119,6,0.10)', fg: '#a16207' },
  'service.renew':         { bg: 'rgba(22,163,74,0.10)', fg: '#15803d' },
  'service.plan_change':   { bg: 'rgba(37,99,235,0.10)', fg: '#1d4ed8' },
  'service.expire':        { bg: 'rgba(220,38,38,0.10)', fg: '#b91c1c' },
  'service.delete':        { bg: 'rgba(220,38,38,0.10)', fg: '#b91c1c' },
  'bulk.import':           { bg: 'rgba(124,58,237,0.10)', fg: '#6d28d9' },
};

function fmtKind(k: string): { bg: string; fg: string } {
  return KIND_COLORS[k] ?? { bg: 'rgba(100,116,139,0.10)', fg: '#475569' };
}

function timeAgo(iso: string): string {
  const past = Date.now() - new Date(iso).getTime();
  const s = Math.round(past / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function AuditPage() {
  const [filters, setFilters] = useState({
    entity_type: '', actor_id: '', kind: '', since: '',
  });
  const [list, setList] = useState<AuditEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => {
    const qs = new URLSearchParams();
    if (filters.entity_type) qs.set('entity_type', filters.entity_type);
    if (filters.actor_id)    qs.set('actor_id', filters.actor_id);
    if (filters.kind)        qs.set('kind', filters.kind);
    if (filters.since)       qs.set('since', filters.since);
    qs.set('limit', '300');
    api<AuditEntry[]>(`/admin/audit?${qs}`)
      .then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [filters]);

  const reset = () => setFilters({ entity_type: '', actor_id: '', kind: '', since: '' });

  return (
    <div className="container">
      <h1>Audit log</h1>
      <p className="sub">
        Every mutation across the system — who changed what, when, and the before/after.
        Powers compliance review, customer-dispute resolution, and post-incident forensics.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          <div>
            <label>Entity type</label>
            <select value={filters.entity_type}
              onChange={(e) => setFilters({ ...filters, entity_type: e.target.value })}>
              <option value="">All</option>
              <option value="customer">Customer</option>
              <option value="service">Service</option>
              <option value="batch">Batch</option>
            </select>
          </div>
          <div>
            <label>Kind</label>
            <select value={filters.kind}
              onChange={(e) => setFilters({ ...filters, kind: e.target.value })}>
              <option value="">All</option>
              {Object.keys(KIND_COLORS).map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Actor</label>
            <input value={filters.actor_id} placeholder="username or customer id"
              onChange={(e) => setFilters({ ...filters, actor_id: e.target.value })} />
          </div>
          <div>
            <label>Since</label>
            <input type="datetime-local" value={filters.since}
              onChange={(e) => setFilters({ ...filters, since: e.target.value })} />
          </div>
          <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <button className="ghost" onClick={reset}>Reset</button>
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="sub">No audit events match.</p>
      ) : list.map((e) => {
        const c = fmtKind(e.kind);
        return (
          <div key={e.id} style={{
            background: '#fff', border: '1px solid var(--border, #e2e8f0)',
            borderRadius: 10, padding: 14, marginBottom: 8,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{
                    background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600,
                    padding: '2px 8px', borderRadius: 4, fontFamily: 'ui-monospace, monospace',
                  }}>{e.kind}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    by <strong style={{ color: '#0f172a' }}>{e.actor_label}</strong>
                    <span style={{ color: 'var(--muted)' }}> ({e.actor_role})</span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>· {timeAgo(e.created_at)}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>
                  {e.entity_type} <code>{e.entity_id.slice(0, 8)}</code>
                </div>
              </div>
              <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                {expanded === e.id ? 'Hide' : 'Details'}
              </button>
            </div>

            {expanded === e.id && (
              <div style={{ marginTop: 12, fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                {e.before && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ color: 'var(--muted)', marginBottom: 4 }}>before</div>
                    <pre style={{ background: 'rgba(220,38,38,0.04)', padding: 8, borderRadius: 6, margin: 0, overflow: 'auto' }}>
                      {JSON.stringify(e.before, null, 2)}
                    </pre>
                  </div>
                )}
                {e.after && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ color: 'var(--muted)', marginBottom: 4 }}>after</div>
                    <pre style={{ background: 'rgba(22,163,74,0.04)', padding: 8, borderRadius: 6, margin: 0, overflow: 'auto' }}>
                      {JSON.stringify(e.after, null, 2)}
                    </pre>
                  </div>
                )}
                {Object.keys(e.metadata).length > 0 && (
                  <div>
                    <div style={{ color: 'var(--muted)', marginBottom: 4 }}>metadata</div>
                    <pre style={{ background: 'rgba(37,99,235,0.04)', padding: 8, borderRadius: 6, margin: 0, overflow: 'auto' }}>
                      {JSON.stringify(e.metadata, null, 2)}
                    </pre>
                  </div>
                )}
                <div style={{ marginTop: 8, color: 'var(--muted)' }}>
                  Full timestamp: {new Date(e.created_at).toISOString()}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
