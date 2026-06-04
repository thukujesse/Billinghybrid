'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Status = 'pending' | 'processing' | 'success' | 'failed' | 'dead';
type Filter = 'all' | Status;

interface PaymentEvent {
  id: string;
  source: string;
  dedup_key: string;
  payload: any;
  status: Status;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

interface QueueHealth {
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  oldestPendingAgeSec: number | null;
}

const BADGES: Record<Status, string> = {
  pending: 'pending',
  processing: 'open',
  failed: 'overdue',
  success: 'success',
  dead: 'failed',
};

export default function PaymentEvents() {
  const [filter, setFilter] = useState<Filter>('all');
  const [list, setList] = useState<PaymentEvent[]>([]);
  const [health, setHealth] = useState<QueueHealth | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () => {
    const qs = filter === 'all' ? '' : `?status=${filter}`;
    api<PaymentEvent[]>(`/admin/payment-events${qs}`).then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));
    api<QueueHealth>('/admin/payment-events/health').then(setHealth).catch(() => {});
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [filter]);

  const retry = async (id: string) => {
    try {
      await api(`/admin/payment-events/${id}/retry`, { method: 'POST' });
      setToast({ ok: true, msg: 'Re-queued for worker pickup' });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    }
  };

  return (
    <div className="container">
      <h1>Payment Events</h1>
      <p className="sub">
        Durable queue for inbound M-Pesa callbacks. The worker drains pending
        rows every few seconds with exponential-backoff retries. Dead rows
        exhausted all attempts — inspect the error, fix the root cause, and
        retry.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card stat">
          <div className="label">Pending</div>
          <div className="value" style={{ color: 'var(--orange)' }}>{health?.pending ?? '—'}</div>
        </div>
        <div className="card stat">
          <div className="label">Processing</div>
          <div className="value">{health?.processing ?? '—'}</div>
        </div>
        <div className="card stat">
          <div className="label">Failed (retrying)</div>
          <div className="value" style={{ color: 'var(--orange)' }}>{health?.failed ?? '—'}</div>
        </div>
        <div className="card stat">
          <div className="label">Dead (DLQ)</div>
          <div className="value" style={{ color: 'var(--red)' }}>{health?.dead ?? '—'}</div>
        </div>
        <div className="card stat">
          <div className="label">Oldest pending</div>
          <div className="value" style={{ fontSize: 20 }}>
            {health?.oldestPendingAgeSec == null ? '—' : `${health.oldestPendingAgeSec}s`}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['all', 'pending', 'processing', 'failed', 'success', 'dead'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={filter === f ? '' : 'ghost'}
            style={{ fontSize: 12 }}
          >
            {f}
          </button>
        ))}
      </div>

      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Dedup key</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Next attempt</th>
            <th>Last error</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((e) => {
            const open = expanded === e.id;
            return (
              <>
                <tr key={e.id} onClick={() => setExpanded(open ? null : e.id)} style={{ cursor: 'pointer' }}>
                  <td><code>{e.source}</code></td>
                  <td><code style={{ fontSize: 11 }}>{e.dedup_key.slice(0, 24)}{e.dedup_key.length > 24 ? '…' : ''}</code></td>
                  <td><span className={`badge ${BADGES[e.status]}`}>{e.status}</span></td>
                  <td>{e.attempts} / {e.max_attempts}</td>
                  <td style={{ fontSize: 12 }}>{e.status === 'pending' || e.status === 'failed' ? relative(e.next_attempt_at) : '—'}</td>
                  <td style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.last_error ?? '—'}
                  </td>
                  <td style={{ fontSize: 12 }}>{relative(e.updated_at)}</td>
                  <td onClick={(ev) => ev.stopPropagation()}>
                    {e.status === 'dead' && (
                      <button onClick={() => retry(e.id)} style={{ fontSize: 11, padding: '4px 10px' }}>Retry</button>
                    )}
                  </td>
                </tr>
                {open && (
                  <tr key={e.id + '_x'}>
                    <td colSpan={8} style={{ background: 'var(--surface)' }}>
                      <pre style={{ fontSize: 11, margin: 0, padding: 12, overflow: 'auto', maxHeight: 320 }}>
{JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
          {list.length === 0 && (
            <tr><td colSpan={8} style={{ color: 'var(--muted)' }}>No events match this filter.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function relative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const s = Math.round(ms / 1000);
  if (s > 60) return `in ${Math.round(s / 60)}m`;
  if (s > 5) return `in ${s}s`;
  if (s >= -60) return `${-s}s ago`;
  if (s >= -3600) return `${Math.round(-s / 60)}m ago`;
  if (s >= -86400) return `${Math.round(-s / 3600)}h ago`;
  return `${Math.round(-s / 86400)}d ago`;
}
