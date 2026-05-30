import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getOrCreateWallet, credit } from '../wallet/service.js';
import { chargeFromWallet } from '../billing/service.js';
import { getSubscriber } from '../subscribers/service.js';
import { stkPush } from './daraja.js';
import { emit } from '../events/bus.js';

export interface Payment {
  id: string;
  subscriber_id: string | null;
  invoice_id: string | null;
  provider: 'mpesa' | 'stripe' | 'wallet' | 'manual';
  provider_ref: string | null;
  idempotency_key: string;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'success' | 'failed';
  created_at: string;
}

async function insertPayment(
  data: Partial<Payment> & { provider: Payment['provider']; amount_cents: number; idempotency_key: string },
  client?: PoolClient
): Promise<Payment> {
  const r = await query<Payment>(
    `INSERT INTO payments
       (subscriber_id, invoice_id, provider, provider_ref, idempotency_key, amount_cents, currency, status, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [
      data.subscriber_id ?? null,
      data.invoice_id ?? null,
      data.provider,
      data.provider_ref ?? null,
      data.idempotency_key,
      data.amount_cents,
      config.currency,
      data.status ?? 'pending',
      JSON.stringify((data as any).raw ?? {}),
    ],
    client
  );
  return r.rows[0];
}

/**
 * Initiate an M-Pesa STK Push (Daraja). Without configured credentials this
 * runs in SIMULATION mode: it returns a checkout id you can confirm via the
 * /confirm endpoint, mimicking the async customer "Enter PIN" callback.
 */
export async function initiateMpesa(input: {
  subscriberId: string;
  amountCents: number;
  invoiceId?: string;
}): Promise<{ payment: Payment; checkoutRequestId: string; simulated: boolean }> {
  if (input.amountCents <= 0) throw badRequest('amount must be positive');

  // Live mode: ask Daraja for a CheckoutRequestID. Simulation mode (no creds):
  // mint our own id that can be confirmed via the callback endpoint.
  let checkoutRequestId = `ws_CO_${randomUUID()}`;
  if (!config.mpesa.simulated) {
    const subscriber = await getSubscriber(input.subscriberId);
    const result = await stkPush({
      phone: subscriber.phone,
      amountKes: Math.round(input.amountCents / 100),
      accountReference: subscriber.phone,
      description: 'Top-up',
    });
    checkoutRequestId = result.checkoutRequestId;
  }

  const payment = await insertPayment({
    subscriber_id: input.subscriberId,
    invoice_id: input.invoiceId,
    provider: 'mpesa',
    provider_ref: checkoutRequestId,
    idempotency_key: checkoutRequestId,
    amount_cents: input.amountCents,
    status: 'pending',
  });

  await emit('payment.initiated', { paymentId: payment.id, provider: 'mpesa' });
  return { payment, checkoutRequestId, simulated: config.mpesa.simulated };
}

/**
 * Settle a payment as successful (the M-Pesa callback / Stripe webhook target).
 * Idempotent: a repeated callback for an already-succeeded payment is a no-op.
 * On success we credit the subscriber wallet, then auto-apply to the invoice.
 */
export async function confirmPayment(
  providerRef: string,
  outcome: 'success' | 'failed' = 'success',
  raw: Record<string, unknown> = {}
): Promise<Payment> {
  const settled = await withTransaction(async (c) => {
    const r = await c.query<Payment>(
      `SELECT * FROM payments WHERE provider_ref = $1 OR idempotency_key = $1 FOR UPDATE`,
      [providerRef]
    );
    const payment = r.rows[0];
    if (!payment) throw notFound('payment');
    if (payment.status === 'success') return payment; // idempotent

    if (outcome === 'failed') {
      const f = await c.query<Payment>(
        `UPDATE payments SET status='failed', raw=$2, updated_at=now() WHERE id=$1 RETURNING *`,
        [payment.id, JSON.stringify(raw)]
      );
      return f.rows[0];
    }

    const updated = await c.query<Payment>(
      `UPDATE payments SET status='success', raw=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [payment.id, JSON.stringify(raw)]
    );
    const ok = updated.rows[0];

    if (ok.subscriber_id) {
      const wallet = await getOrCreateWallet('subscriber', ok.subscriber_id, c);
      await credit(wallet.id, ok.amount_cents, `${ok.provider} payment`, { type: 'payment', id: ok.id }, c);
    }
    return ok;
  });

  if (settled.status === 'success') {
    await emit('payment.paid', {
      paymentId: settled.id,
      subscriberId: settled.subscriber_id,
      amount: settled.amount_cents,
    });
    // Apply funds to the linked invoice (outside the credit txn so the wallet
    // balance is already committed before we settle the invoice from it).
    if (settled.invoice_id) {
      await chargeFromWallet(settled.invoice_id);
    }
  } else {
    await emit('payment.failed', { paymentId: settled.id });
  }
  return settled;
}

/** Direct wallet top-up via Stripe (simulated unless STRIPE_SECRET_KEY set). */
export async function topUpViaStripe(input: {
  subscriberId: string;
  amountCents: number;
}): Promise<{ payment: Payment; clientSecret: string; simulated: boolean }> {
  if (input.amountCents <= 0) throw badRequest('amount must be positive');
  const ref = `pi_${randomUUID()}`;
  const payment = await insertPayment({
    subscriber_id: input.subscriberId,
    provider: 'stripe',
    provider_ref: ref,
    idempotency_key: ref,
    amount_cents: input.amountCents,
    status: 'pending',
  });
  return { payment, clientSecret: `${ref}_secret`, simulated: config.stripe.simulated };
}

export async function listPayments(subscriberId?: string): Promise<Payment[]> {
  const r = subscriberId
    ? await query<Payment>('SELECT * FROM payments WHERE subscriber_id = $1 ORDER BY created_at DESC', [subscriberId])
    : await query<Payment>('SELECT * FROM payments ORDER BY created_at DESC LIMIT 200');
  return r.rows;
}
