import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { completePurchase } from '../hotspot/service.js';

/**
 * Payment reconciliation. Inbound confirmations that don't auto-match a pending
 * purchase are parked here so an operator can recover them: "claim" creates a
 * purchase for a chosen plan + phone and grants access (reusing completePurchase),
 * or "ignore" dismisses it. Dedup is on the provider transaction id.
 */

export interface UnmatchedInput {
  source: string;                     // c2b | jenga | bank_stk | intasend | kopokopo
  transId: string;
  amount: number;
  msisdn?: string;
  reference?: string;
  reason: 'no_match' | 'underpaid';
  raw?: unknown;
}

/** Park an unmatched payment (idempotent on trans_id). Best-effort: never throws
 *  into the callback path — a logging failure must not 500 the IPN. */
export async function recordUnmatched(i: UnmatchedInput): Promise<void> {
  if (!i.transId) return;
  try {
    await query(
      `INSERT INTO unmatched_payment (source, trans_id, amount_kes, msisdn, reference, reason, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (trans_id) DO NOTHING`,
      [i.source, i.transId, Math.round(i.amount), i.msisdn ?? '', i.reference ?? '', i.reason,
       i.raw ? JSON.stringify(i.raw) : null]
    );
  } catch (e) {
    console.error('[unmatched] record failed:', (e as Error).message);
  }
}

export async function listUnmatched(status = 'unmatched', limit = 100) {
  const r = await query(
    `SELECT id, source, trans_id, amount_kes, msisdn, reference, reason, status,
            claimed_purchase_id, resolved_by, resolved_at, created_at
       FROM unmatched_payment
      WHERE ($1 = 'all' OR status = $1)
      ORDER BY created_at DESC LIMIT $2`,
    [status, Math.min(limit, 500)]
  );
  return r.rows;
}

export async function unmatchedStats(): Promise<{ open: number; openAmountKes: number }> {
  const r = await query<{ open: string; open_amount: string }>(
    `SELECT count(*) FILTER (WHERE status='unmatched')::text AS open,
            COALESCE(sum(amount_kes) FILTER (WHERE status='unmatched'),0)::text AS open_amount
       FROM unmatched_payment`
  );
  return { open: Number(r.rows[0].open), openAmountKes: Number(r.rows[0].open_amount) };
}

export async function ignoreUnmatched(id: string, resolvedBy?: string): Promise<void> {
  const r = await query(
    `UPDATE unmatched_payment SET status='ignored', resolved_by=$2, resolved_at=now()
      WHERE id=$1 AND status='unmatched'`,
    [id, resolvedBy ?? 'admin']
  );
  if (!r.rowCount) throw badRequest('payment is not open for resolution');
}

/** Recover an unmatched payment: mint a purchase for the chosen plan + phone and
 *  grant access (same path as a real settlement), then mark it claimed. */
export async function claimUnmatched(
  id: string, opts: { planId: string; phone?: string; mac?: string }, resolvedBy?: string
): Promise<{ ok: true; checkoutRequestId: string }> {
  const up = (await query<{ trans_id: string; amount_kes: number; msisdn: string; status: string }>(
    `SELECT trans_id, amount_kes, msisdn, status FROM unmatched_payment WHERE id=$1`, [id]
  )).rows[0];
  if (!up) throw notFound('unmatched payment');
  if (up.status !== 'unmatched') throw badRequest('payment already resolved');

  const plan = (await query<{ id: string }>(
    `SELECT id FROM plans WHERE id=$1 AND active=TRUE`, [opts.planId]
  )).rows[0];
  if (!plan) throw notFound('plan');

  const phone = (opts.phone || up.msisdn || '').replace(/\D/g, '');
  if (phone.length < 9) throw badRequest('a valid phone is required to grant access');

  const crid = 'CLAIM-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  await query(
    `INSERT INTO hotspot_purchases (checkout_request_id, plan_id, phone, mac_address, amount_kes, status)
     VALUES ($1,$2,$3,$4,$5,'pending')`,
    [crid, plan.id, phone, opts.mac ?? null, up.amount_kes]
  );
  // Use the bank/M-Pesa transaction id as the receipt (audit + idempotency).
  await completePurchase({ checkoutRequestId: crid, success: true, receipt: up.trans_id });

  const purchase = (await query<{ id: string }>(
    `SELECT id FROM hotspot_purchases WHERE checkout_request_id=$1`, [crid]
  )).rows[0];
  await query(
    `UPDATE unmatched_payment SET status='claimed', claimed_purchase_id=$2, resolved_by=$3, resolved_at=now()
      WHERE id=$1`,
    [id, purchase?.id ?? null, resolvedBy ?? 'admin']
  );
  return { ok: true, checkoutRequestId: crid };
}
