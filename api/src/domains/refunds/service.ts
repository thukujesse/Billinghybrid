import { query, withTransaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { getOrCreateWallet, debit } from '../wallet/service.js';
import { emit } from '../events/bus.js';

export interface Refund {
  id: string;
  payment_id: string;
  subscriber_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string | null;
  method: 'wallet' | 'mpesa' | 'manual';
  status: 'pending' | 'completed' | 'failed';
  created_at: string;
}

/** Total already refunded against a payment. */
async function refundedSoFar(paymentId: string): Promise<number> {
  const r = await query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint AS total
     FROM refunds WHERE payment_id = $1 AND status != 'failed'`,
    [paymentId]
  );
  return Number(r.rows[0].total);
}

/**
 * Refund a successful payment, fully or partially. Cannot exceed the
 * un-refunded remainder. method 'wallet' claws the funds back out of the
 * subscriber wallet (it must have the balance); 'mpesa'/'manual' record an
 * external disbursement without touching the wallet.
 */
export async function createRefund(input: {
  paymentId: string;
  amountCents?: number;
  reason?: string;
  method?: 'wallet' | 'mpesa' | 'manual';
}): Promise<Refund> {
  const method = input.method ?? 'wallet';

  return withTransaction(async (c) => {
    const pr = await c.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [input.paymentId]);
    const payment = pr.rows[0];
    if (!payment) throw notFound('payment');
    if (payment.status !== 'success') throw conflict('only successful payments can be refunded');

    const already = await refundedSoFar(input.paymentId);
    const remaining = payment.amount_cents - already;
    const amount = input.amountCents ?? remaining;
    if (amount <= 0) throw badRequest('refund amount must be positive');
    if (amount > remaining) throw badRequest(`refund exceeds remaining refundable amount (${remaining})`);

    if (method === 'wallet' && payment.subscriber_id) {
      const wallet = await getOrCreateWallet('subscriber', payment.subscriber_id, c);
      // Throws 402 if the wallet can't cover the claw-back.
      await debit(wallet.id, amount, `Refund of payment ${payment.id}`, { type: 'refund', id: payment.id }, c);
    }

    const r = await c.query<Refund>(
      `INSERT INTO refunds (payment_id, subscriber_id, amount_cents, currency, reason, method, status)
       VALUES ($1,$2,$3,$4,$5,$6,'completed') RETURNING *`,
      [input.paymentId, payment.subscriber_id, amount, config.currency, input.reason ?? null, method]
    );
    const refund = r.rows[0];
    await emit('payment.refunded', { refundId: refund.id, paymentId: input.paymentId, amount, method });
    return refund;
  });
}

export async function listRefunds(paymentId?: string): Promise<Refund[]> {
  const r = paymentId
    ? await query<Refund>('SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at DESC', [paymentId])
    : await query<Refund>('SELECT * FROM refunds ORDER BY created_at DESC LIMIT 200');
  return r.rows;
}
