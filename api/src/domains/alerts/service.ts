/**
 * Operator alert engine. Periodically checks system health, opens an
 * alert_events row on first detection of a bad condition, fires a
 * Telegram to the admin chat, and closes the alert when the condition
 * clears. Dedup via (kind, dedup_key) UNIQUE WHERE status <> 'resolved'.
 *
 * Adding a new alert: implement an evaluator function that returns an
 * array of Candidate alerts and add it to the EVALUATORS list. The
 * runEvaluators() driver handles open/resolve/Telegram fan-out.
 */
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { queueHealth } from '../paymentEvents/service.js';
import { notify } from '../notifications/service.js';

export interface Candidate {
  kind: 'dlq_items' | 'queue_backlog' | 'router_offline' | 'expire_sms_failed' | 'radius_unreachable';
  severity: 'info' | 'warning' | 'critical';
  dedup_key: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AlertRow {
  id: string;
  kind: Candidate['kind'];
  severity: Candidate['severity'];
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

// ---------- Evaluators ----------

/** Payment events stuck in 'dead' (DLQ) — exhausted all retry attempts.
 *  Almost always means a code-level bug or Daraja outage; the operator
 *  needs to look, retry manually, or fix the underlying handler. */
async function evalDlq(): Promise<Candidate[]> {
  const h = await queueHealth();
  if (h.dead === 0) return [];
  return [{
    kind: 'dlq_items',
    severity: 'critical',
    dedup_key: 'global',
    message: `${h.dead} payment event(s) in DLQ — manual intervention required`,
    details: { dead_count: h.dead },
  }];
}

/** Queue backlog — pending events building up faster than the worker
 *  drains. Threshold of 50 covers normal STK volume; sustained above is
 *  a sign of worker outage, DB lock contention, or Daraja flapping. */
async function evalQueueBacklog(): Promise<Candidate[]> {
  const h = await queueHealth();
  if (h.pending < 50) return [];
  const ageMin = h.oldestPendingAgeSec ? Math.round(h.oldestPendingAgeSec / 60) : 0;
  return [{
    kind: 'queue_backlog',
    severity: h.pending >= 200 ? 'critical' : 'warning',
    dedup_key: 'global',
    message: `Payment queue has ${h.pending} pending event(s), oldest ${ageMin}m old`,
    details: { pending: h.pending, oldest_age_min: ageMin },
  }];
}

/** WireGuard router silent for >5 minutes. wg-jtm has a 90s in-script
 *  watchdog and pollVpsHandshakes hits every 30s, so stale > 5min means
 *  the router is genuinely down (power, ISP, ports blocked) not a brief
 *  network blip. */
async function evalRouterOffline(): Promise<Candidate[]> {
  const r = await query<{
    id: string; name: string; last_handshake_at: string | null;
  }>(
    `SELECT id, name, last_handshake_at
       FROM routers
      WHERE wg_tunnel_ip IS NOT NULL
        AND (last_handshake_at IS NULL OR last_handshake_at < now() - interval '5 minutes')`
  );
  return r.rows.map((row) => {
    const min = row.last_handshake_at
      ? Math.round((Date.now() - new Date(row.last_handshake_at).getTime()) / 60_000)
      : null;
    return {
      kind: 'router_offline' as const,
      severity: 'critical' as const,
      dedup_key: row.id,
      message: row.last_handshake_at
        ? `Router "${row.name}" silent for ${min}m`
        : `Router "${row.name}" has never connected`,
      details: { router_id: row.id, router_name: row.name, last_handshake_at: row.last_handshake_at, silent_min: min },
    };
  });
}

const EVALUATORS = [evalDlq, evalQueueBacklog, evalRouterOffline];

// ---------- Driver ----------

/**
 * One sweep: run every evaluator, open new alerts, resolve cleared ones,
 * fire Telegram for newly-opened. Idempotent — repeated calls don't
 * spam (existing open rows just get last_seen_at touched).
 */
export async function runEvaluators(): Promise<{ opened: AlertRow[]; resolved: AlertRow[] }> {
  const opened: AlertRow[] = [];
  const resolved: AlertRow[] = [];

  // Collect candidates from every evaluator.
  const all: Candidate[] = [];
  for (const evalFn of EVALUATORS) {
    try {
      all.push(...(await evalFn()));
    } catch (err) {
      console.error('[alerts] evaluator failed:', (err as Error).message);
    }
  }

  // Open or refresh each candidate.
  const seenKeys = new Set<string>();
  for (const cand of all) {
    seenKeys.add(`${cand.kind}::${cand.dedup_key}`);
    // Atomically: open new alert OR touch last_seen_at on existing.
    // ON CONFLICT (kind, dedup_key) WHERE status <> 'resolved' matches
    // the partial unique index so re-opens after resolve are fine.
    const r = await query<AlertRow & { was_new: boolean }>(
      `INSERT INTO alert_events (kind, severity, dedup_key, message, details, last_seen_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (kind, dedup_key) WHERE status <> 'resolved'
       DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                     message = EXCLUDED.message,
                     details = EXCLUDED.details,
                     severity = EXCLUDED.severity
       RETURNING *, (xmax = 0) AS was_new`,
      [cand.kind, cand.severity, cand.dedup_key, cand.message, JSON.stringify(cand.details ?? {})]
    );
    const row = r.rows[0];
    if (row?.was_new) {
      opened.push(row);
      fireTelegram(row).catch((e) => console.error('[alerts] telegram failed:', e));
    }
  }

  // Resolve alerts whose condition cleared.
  // (open|acked) rows that no evaluator surfaced this tick → close.
  const stillOpenR = await query<AlertRow>(
    `SELECT * FROM alert_events WHERE status IN ('open','acked')`
  );
  for (const row of stillOpenR.rows) {
    const key = `${row.kind}::${row.dedup_key}`;
    if (seenKeys.has(key)) continue;
    const upd = await query<AlertRow>(
      `UPDATE alert_events SET status = 'resolved', resolved_at = now()
        WHERE id = $1 AND status IN ('open','acked')
        RETURNING *`,
      [row.id]
    );
    if (upd.rows[0]) {
      resolved.push(upd.rows[0]);
      fireTelegramResolved(upd.rows[0]).catch((e) => console.error('[alerts] telegram failed:', e));
    }
  }

  return { opened, resolved };
}

async function fireTelegram(row: AlertRow): Promise<void> {
  const sev = row.severity === 'critical' ? 'CRITICAL' : row.severity === 'warning' ? 'WARN' : 'INFO';
  const body = `[${sev}] ${config.brandName}: ${row.message}`;
  for (const chat of config.telegram.adminChatIds) {
    await notify('telegram', chat, body);
  }
}

async function fireTelegramResolved(row: AlertRow): Promise<void> {
  const body = `[RESOLVED] ${config.brandName}: ${row.message}`;
  for (const chat of config.telegram.adminChatIds) {
    await notify('telegram', chat, body);
  }
}

// ---------- Admin helpers ----------

export async function listAlerts(filter: { status?: 'open' | 'acked' | 'resolved' | 'all'; limit?: number } = {}): Promise<AlertRow[]> {
  const limit = Math.min(filter.limit ?? 200, 1000);
  if (!filter.status || filter.status === 'all') {
    const r = await query<AlertRow>(
      `SELECT * FROM alert_events ORDER BY opened_at DESC LIMIT $1`, [limit]
    );
    return r.rows;
  }
  const r = await query<AlertRow>(
    `SELECT * FROM alert_events WHERE status = $1 ORDER BY opened_at DESC LIMIT $2`,
    [filter.status, limit]
  );
  return r.rows;
}

export async function ackAlert(id: string, by: string): Promise<AlertRow> {
  const r = await query<AlertRow>(
    `UPDATE alert_events SET status = 'acked', acked_at = now(), acked_by = $2
      WHERE id = $1 AND status = 'open' RETURNING *`,
    [id, by]
  );
  if (!r.rows[0]) throw new Error('alert not found or not in open state');
  return r.rows[0];
}
