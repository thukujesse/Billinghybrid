/**
 * Payment events queue — system-of-record for inbound Daraja callbacks.
 *
 * Lifecycle:
 *   enqueue() inserts a row (or no-ops on duplicate dedup_key).
 *   claimBatch() pulls due rows with SELECT ... FOR UPDATE SKIP LOCKED,
 *     stamps them 'processing' + locked_at/locked_by, returns them.
 *   markSuccess() / markFailure() are called by the worker after each job.
 *   moveToDlq() is called automatically when attempts >= max_attempts;
 *     status flips to 'dead' and a notification fires.
 *   reapStaleLocks() releases rows stuck in 'processing' (crashed workers).
 */
import { query, withTransaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { notify } from '../notifications/service.js';

export type PaymentEventStatus = 'pending' | 'processing' | 'success' | 'failed' | 'dead';

export interface PaymentEvent {
  id: string;
  source: string;
  dedup_key: string;
  payload: any;
  status: PaymentEventStatus;
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

// Exponential backoff schedule for retries (seconds). Index = number of
// failures recorded so far; first retry waits 15s, fifth waits 2h. If
// attempts >= max_attempts the row is moved to DLQ instead of retried.
const BACKOFF_SECONDS = [15, 60, 300, 1800, 7200];

function nextRetryDelaySec(failuresSoFar: number): number {
  // failuresSoFar is already incremented when called (we just recorded a
  // failure), so failuresSoFar=1 means "first retry, wait BACKOFF_SECONDS[0]".
  const idx = Math.max(0, failuresSoFar - 1);
  return BACKOFF_SECONDS[Math.min(idx, BACKOFF_SECONDS.length - 1)];
}

/**
 * Enqueue an inbound payment event. Returns true if a new row was inserted,
 * false if a duplicate (source, dedup_key) already exists. Either way, the
 * caller can immediately ACK the upstream webhook.
 */
export async function enqueue(
  source: string,
  dedupKey: string,
  payload: unknown
): Promise<boolean> {
  const r = await query(
    `INSERT INTO payment_events (source, dedup_key, payload, max_attempts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, dedup_key) DO NOTHING
     RETURNING id`,
    [source, dedupKey, JSON.stringify(payload), config.paymentQueue.maxAttempts]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Claim up to `limit` due jobs for this worker. Uses SKIP LOCKED so multiple
 * workers can run concurrently without contention. Returns the claimed rows
 * (now flagged 'processing'); empty array means nothing to do.
 */
export async function claimBatch(workerId: string, limit: number): Promise<PaymentEvent[]> {
  const r = await query<PaymentEvent>(
    `WITH claimed AS (
       SELECT id FROM payment_events
        WHERE status IN ('pending','failed')
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE payment_events e
        SET status='processing',
            locked_at=now(),
            locked_by=$2,
            updated_at=now()
       FROM claimed
      WHERE e.id = claimed.id
      RETURNING e.*`,
    [limit, workerId]
  );
  return r.rows;
}

export async function markSuccess(id: string): Promise<void> {
  await query(
    `UPDATE payment_events
        SET status='success',
            locked_at=NULL, locked_by=NULL,
            settled_at=now(), updated_at=now(),
            last_error=NULL
      WHERE id=$1`,
    [id]
  );
}

/**
 * Mark a job failed. If new attempts count < max_attempts, schedules a
 * retry with exponential backoff. Otherwise moves the row to DLQ (status
 * 'dead' + audit snapshot + admin notification) in the same transaction.
 */
export async function markFailure(id: string, errorMsg: string): Promise<void> {
  let deadRow: PaymentEvent | null = null;

  await withTransaction(async (c) => {
    // Step 1: bump attempts and record the error so we know the new count.
    const r = await c.query<PaymentEvent>(
      `UPDATE payment_events
          SET attempts   = attempts + 1,
              last_error = $2,
              locked_at  = NULL, locked_by = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, errorMsg.slice(0, 2000)]
    );
    const row = r.rows[0];
    if (!row) return;

    if (row.attempts >= row.max_attempts) {
      // Step 2a: exhausted — move to DLQ and snapshot.
      await c.query(
        `UPDATE payment_events SET status='dead', updated_at=now() WHERE id=$1`,
        [id]
      );
      await c.query(
        `INSERT INTO payment_events_dlq_audit (event_id, reason, snapshot)
         VALUES ($1, $2, $3)`,
        [
          id,
          `exhausted ${row.max_attempts} attempts: ${errorMsg.slice(0, 200)}`,
          JSON.stringify(row),
        ]
      );
      deadRow = row;
    } else {
      // Step 2b: schedule the next retry with backoff matching new attempts.
      await c.query(
        `UPDATE payment_events
            SET status = 'failed',
                next_attempt_at = now() + ($2 || ' seconds')::interval
          WHERE id = $1`,
        [id, nextRetryDelaySec(row.attempts)]
      );
    }
  });

  // Notify AFTER commit so an alert outage can't roll back the DB write.
  if (deadRow) {
    fireDlqAlert(deadRow).catch((e) => console.error('[dlq-alert]', e));
  }
}

/** Reset rows stuck in 'processing' past the stale-lock threshold. */
export async function reapStaleLocks(): Promise<number> {
  const r = await query(
    `UPDATE payment_events
        SET status='pending',
            locked_at=NULL, locked_by=NULL,
            updated_at=now()
      WHERE status='processing'
        AND locked_at < now() - ($1 || ' milliseconds')::interval`,
    [config.paymentQueue.staleLockMs]
  );
  return r.rowCount ?? 0;
}

async function fireDlqAlert(row: PaymentEvent): Promise<void> {
  const ch = config.paymentQueue.dlqAlertChannel;
  const to = config.paymentQueue.dlqAlertTo;
  const msg =
    `JTM Payment DLQ\n` +
    `event ${row.id} (${row.source}, dedup ${row.dedup_key}) dead after ${row.attempts} attempts.\n` +
    `Last error: ${row.last_error ?? '(none)'}`;
  if (!ch) {
    console.error('[dlq]', msg);
    return;
  }
  await notify(ch, to, msg);
}

// ---------- admin/listing helpers ----------

export interface ListFilters {
  status?: PaymentEventStatus;
  source?: string;
  limit?: number;
}

export async function listEvents(f: ListFilters): Promise<PaymentEvent[]> {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.status) { vals.push(f.status); where.push(`status = $${vals.length}`); }
  if (f.source) { vals.push(f.source); where.push(`source = $${vals.length}`); }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  vals.push(limit);
  const sql = `SELECT * FROM payment_events
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY updated_at DESC
                LIMIT $${vals.length}`;
  const r = await query<PaymentEvent>(sql, vals);
  return r.rows;
}

export interface QueueHealth {
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  oldestPendingAgeSec: number | null;
}

export async function queueHealth(): Promise<QueueHealth> {
  const r = await query<{
    status: PaymentEventStatus;
    n: number;
    oldest: string | null;
  }>(
    `SELECT status, COUNT(*)::int AS n,
            MIN(next_attempt_at) FILTER (WHERE status IN ('pending','failed')) AS oldest
       FROM payment_events
      WHERE status IN ('pending','processing','failed','dead')
      GROUP BY status`
  );
  const out: QueueHealth = { pending: 0, processing: 0, failed: 0, dead: 0, oldestPendingAgeSec: null };
  let oldest: Date | null = null;
  for (const row of r.rows) {
    if (row.status === 'pending') out.pending = row.n;
    if (row.status === 'processing') out.processing = row.n;
    if (row.status === 'failed') out.failed = row.n;
    if (row.status === 'dead') out.dead = row.n;
    if (row.oldest) {
      const d = new Date(row.oldest);
      if (!oldest || d < oldest) oldest = d;
    }
  }
  if (oldest) out.oldestPendingAgeSec = Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000));
  return out;
}

/** Reset a dead row so the worker picks it up again. Admin-driven recovery. */
export async function retryEvent(id: string): Promise<PaymentEvent | null> {
  const r = await query<PaymentEvent>(
    `UPDATE payment_events
        SET status='pending', attempts=0, next_attempt_at=now(),
            locked_at=NULL, locked_by=NULL, last_error=NULL,
            updated_at=now()
      WHERE id=$1
      RETURNING *`,
    [id]
  );
  return r.rows[0] ?? null;
}
