'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Alert {
  id: string;
  kind: 'dlq_items' | 'queue_backlog' | 'router_offline' | 'expire_sms_failed' | 'radius_unreachable';
  severity: 'info' | 'warning' | 'critical';
  dedup_key: string;
  message: string;
  details: Record<string, unknown>;
  status: 'open' | 'acked' | 'resolved';
  opened_at: string;
  acked_at: string | null;
  acked_by: string | null;
  resolved_at: string | null;
  last_seen_at: string;
}

const SEV_STYLES: Record<Alert['severity'], { bg: string; fg: string; border: string }> = {
  info:     { bg: 'rgba(37,99,235,0.06)',  fg: '#1d4ed8', border: 'rgba(37,99,235,0.2)' },
  warning:  { bg: 'rgba(217,119,6,0.08)',  fg: '#a16207', border: 'rgba(217,119,6,0.25)' },
  critical: { bg: 'rgba(220,38,38,0.08)',  fg: '#b91c1c', border: 'rgba(220,38,38,0.25)' },
};

const KIND_LABEL: Record<Alert['kind'], string> = {
  dlq_items: 'Payment DLQ',
  queue_backlog: 'Queue backlog',
  router_offline: 'Router offline',
  expire_sms_failed: 'Expire SMS failed',
  radius_unreachable: 'RADIUS unreachable',
};

function relativeTime(iso: string): string {
  const past = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.round(past / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function AlertsPage() {
  const [filter, setFilter] = useState<'open' | 'acked' | 'resolved' | 'all'>('open');
  const [list, setList] = useState<Alert[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () =>
    api<Alert[]>(`/admin/alerts?status=${filter}&limit=200`)
      .then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));

  useEffect(() => {
    load();
    // Live-ish refresh — the 5-min worker is the source of truth but
    // operators want the UI to look fresh after they click Evaluate now.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [filter]);

  const ack = async (a: Alert) => {
    setBusy(a.id);
    try {
      await api(`/admin/alerts/${a.id}/ack`, { method: 'POST' });
      setToast({ ok: true, msg: 'Acknowledged' });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  };

  const evaluateNow = async () => {
    setBusy('eval');
    try {
      const r = await api<{ opened: Alert[]; resolved: Alert[] }>('/admin/alerts/evaluate', { method: 'POST' });
      setToast({
        ok: true,
        msg: `Sweep done · ${r.opened.length} opened, ${r.resolved.length} resolved`,
      });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  };

  const openCount = list.filter((a) => a.status === 'open').length;
  const ackedCount = list.filter((a) => a.status === 'acked').length;
  const criticalCount = list.filter((a) => a.severity === 'critical' && a.status !== 'resolved').length;

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <h1>Alerts</h1>
          <p className="sub">
            Operator-facing health checks. Worker sweeps every 5 minutes and fires Telegram on new conditions.
            Resolved alerts close themselves when the underlying issue clears.
          </p>
        </div>
        <button onClick={evaluateNow} disabled={busy === 'eval'} className="ghost">
          {busy === 'eval' ? 'Sweeping…' : 'Evaluate now'}
        </button>
      </div>

      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="grid" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="label">Open</div>
          <div className="value" style={{ color: openCount > 0 ? '#b91c1c' : 'inherit' }}>{openCount}</div>
        </div>
        <div className="card stat">
          <div className="label">Acknowledged</div>
          <div className="value" style={{ color: ackedCount > 0 ? '#a16207' : 'inherit' }}>{ackedCount}</div>
        </div>
        <div className="card stat">
          <div className="label">Critical (open)</div>
          <div className="value" style={{ color: criticalCount > 0 ? '#b91c1c' : 'inherit' }}>{criticalCount}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['open', 'acked', 'resolved', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={f === filter ? '' : 'ghost'}
            style={{ fontSize: 12, padding: '6px 12px', textTransform: 'capitalize' }}
          >
            {f}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="sub">No {filter === 'all' ? '' : filter} alerts.</p>
      ) : list.map((a) => {
        const sev = SEV_STYLES[a.severity];
        return (
          <div
            key={a.id}
            style={{
              background: a.status === 'resolved' ? 'transparent' : sev.bg,
              border: `1px solid ${a.status === 'resolved' ? 'var(--border, #e2e8f0)' : sev.border}`,
              borderRadius: 10,
              padding: 14,
              marginBottom: 10,
              opacity: a.status === 'resolved' ? 0.7 : 1,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{
                    background: a.status === 'resolved' ? 'transparent' : sev.fg,
                    color: a.status === 'resolved' ? sev.fg : '#fff',
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    border: a.status === 'resolved' ? `1px solid ${sev.fg}` : 'none',
                  }}>{a.severity}</span>
                  <strong style={{ fontSize: 13 }}>{KIND_LABEL[a.kind]}</strong>
                  <span style={{
                    fontSize: 10, color: 'var(--muted)', padding: '2px 6px', borderRadius: 4,
                    background: 'rgba(0,0,0,0.04)',
                  }}>
                    {a.status}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>{a.message}</div>
                {Object.keys(a.details).length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, fontFamily: 'ui-monospace, monospace' }}>
                    {JSON.stringify(a.details)}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  Opened {relativeTime(a.opened_at)}
                  {a.acked_at && <> · ack'd by {a.acked_by} {relativeTime(a.acked_at)}</>}
                  {a.resolved_at && <> · resolved {relativeTime(a.resolved_at)}</>}
                  {a.status !== 'resolved' && <> · last seen {relativeTime(a.last_seen_at)}</>}
                </div>
              </div>
              {a.status === 'open' && (
                <button onClick={() => ack(a)} disabled={busy === a.id} className="ghost"
                  style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}>
                  {busy === a.id ? '…' : 'Acknowledge'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
