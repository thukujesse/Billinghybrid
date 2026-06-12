import { pool } from '../../db/pool.js';
import { config } from '../../config.js';

// ---------------------------------------------------------------------------
// Per-tenant prepaid SMS balance (control DB). Tenants without their own sender
// ID send via HubNet's shared sender and are charged KES 0.40 per 160-char
// segment. Operator tops up; sends are blocked (and logged) at insufficient
// balance. All money is in KES cents.
// ---------------------------------------------------------------------------

/** Number of SMS segments for a message (160 chars each, min 1). */
export function segmentsFor(message: string): number {
  const n = config.control.sms.segmentChars || 160;
  return Math.max(1, Math.ceil((message?.length ?? 0) / n));
}

/** Cost in cents to send `message` on the shared sender. */
export function costFor(message: string): number {
  return segmentsFor(message) * config.control.sms.costCentsPerSegment;
}

export interface SmsAccount { tenant_id: string; balance_cents: number; updated_at: string }

export async function getBalance(tenantId: string): Promise<number> {
  const r = await pool.query<{ b: number }>(
    `SELECT balance_cents AS b FROM tenant_sms_account WHERE tenant_id = $1`, [tenantId]
  );
  return r.rows[0]?.b ?? 0;
}

async function record(client: { query: typeof pool.query }, tenantId: string, delta: number, after: number, reason: string, meta?: string) {
  await client.query(
    `INSERT INTO tenant_sms_ledger (tenant_id, delta_cents, balance_after_cents, reason, meta)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, delta, after, reason, meta ?? null]
  );
}

/** Add credit (top-up / welcome / refund). Idempotent-creates the account. */
export async function credit(tenantId: string, cents: number, reason = 'topup', meta?: string): Promise<number> {
  const r = await pool.query<{ b: number }>(
    `INSERT INTO tenant_sms_account (tenant_id, balance_cents, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (tenant_id) DO UPDATE SET balance_cents = tenant_sms_account.balance_cents + $2, updated_at = now()
     RETURNING balance_cents AS b`,
    [tenantId, cents]
  );
  const after = r.rows[0].b;
  await record(pool, tenantId, cents, after, reason, meta);
  return after;
}

/**
 * Atomically charge `cents` if the balance covers it. Returns { ok, balance }.
 * ok=false (and no debit) when the balance is insufficient — caller skips the send.
 */
export async function charge(tenantId: string, cents: number, meta?: string): Promise<{ ok: boolean; balance: number }> {
  const r = await pool.query<{ b: number }>(
    `UPDATE tenant_sms_account SET balance_cents = balance_cents - $2, updated_at = now()
      WHERE tenant_id = $1 AND balance_cents >= $2
      RETURNING balance_cents AS b`,
    [tenantId, cents]
  );
  if (r.rowCount === 0) return { ok: false, balance: await getBalance(tenantId) };
  const after = r.rows[0].b;
  await record(pool, tenantId, -cents, after, 'sms', meta);
  return { ok: true, balance: after };
}

/** Give back a charge when the send actually failed. */
export async function refund(tenantId: string, cents: number, meta?: string): Promise<void> {
  await credit(tenantId, cents, 'refund', meta);
}

export interface LedgerRow {
  id: string; delta_cents: number; balance_after_cents: number; reason: string; meta: string | null; created_at: string;
}

export async function recentLedger(tenantId: string, limit = 20): Promise<LedgerRow[]> {
  const r = await pool.query<LedgerRow>(
    `SELECT id, delta_cents, balance_after_cents, reason, meta, created_at
       FROM tenant_sms_ledger WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit]
  );
  return r.rows;
}
