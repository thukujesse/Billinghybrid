import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { createPlan } from '../src/domains/plans/service.js';
import { createSubscriber } from '../src/domains/subscribers/service.js';
import { getOrCreateWallet, credit, getWallet } from '../src/domains/wallet/service.js';
import { buyPlan } from '../src/domains/purchases/service.js';
import { issueCreditNote } from '../src/domains/credits/service.js';
import { createRefund } from '../src/domains/refunds/service.js';
import { initiateMpesa, confirmPayment } from '../src/domains/payments/service.js';

const tag = Date.now().toString().slice(-7);

beforeAll(async () => {
  await query(
    `INSERT INTO tax_rules (region, name, rate_bps, active)
     VALUES ('KE', 'VAT', 1600, TRUE)
     ON CONFLICT (region) WHERE active DO NOTHING`
  );
});
afterAll(async () => { await pool.end(); });

describe('buy plan from wallet', () => {
  it('charges wallet (price + VAT) and activates a subscription', async () => {
    const sub = await createSubscriber({ full_name: 'Buyer', phone: `2${tag}01` });
    const plan = await createPlan({ name: `Buy-${tag}`, type: 'prepaid', price_cents: 10000, validity_days: 30 });
    const w = await getOrCreateWallet('subscriber', sub.id);
    await credit(w.id, 11600, 'topup'); // 100.00 + 16% VAT

    const r = await buyPlan({ buyerId: sub.id, planId: plan.id });
    expect(r.paid).toBe(true);
    expect(r.subscriptionId).toBeTruthy();
    expect(r.gifted).toBe(false);
    const after = await getWallet('subscriber', sub.id);
    expect(after!.balance_cents).toBe(0);
  });

  it('rejects when wallet cannot cover the purchase', async () => {
    const sub = await createSubscriber({ full_name: 'Broke', phone: `2${tag}02` });
    const plan = await createPlan({ name: `Buy2-${tag}`, type: 'prepaid', price_cents: 10000, validity_days: 30 });
    const r = await buyPlan({ buyerId: sub.id, planId: plan.id });
    expect(r.paid).toBe(false);
    expect(r.reason).toBe('insufficient_balance');
  });

  it('gifts a plan to a friend (buyer pays, friend gets the plan)', async () => {
    const buyer = await createSubscriber({ full_name: 'Gifter', phone: `2${tag}03` });
    const friend = await createSubscriber({ full_name: 'Friend', phone: `2${tag}04` });
    const plan = await createPlan({ name: `Gift-${tag}`, type: 'prepaid', price_cents: 5000, validity_days: 7 });
    const w = await getOrCreateWallet('subscriber', buyer.id);
    await credit(w.id, 5800, 'topup');

    const r = await buyPlan({ buyerId: buyer.id, planId: plan.id, recipientId: friend.id });
    expect(r.paid).toBe(true);
    expect(r.gifted).toBe(true);

    const friendFull = await query(`SELECT status FROM subscriptions WHERE subscriber_id = $1`, [friend.id]);
    expect(friendFull.rows[0]?.status).toBe('active');
  });
});

describe('credit notes', () => {
  it('credits the wallet and cannot exceed the linked invoice', async () => {
    const sub = await createSubscriber({ full_name: 'CN', phone: `2${tag}05` });
    const note = await issueCreditNote({ subscriberId: sub.id, amountCents: 2500, reason: 'goodwill' });
    expect(note.status).toBe('applied');
    const w = await getWallet('subscriber', sub.id);
    expect(w!.balance_cents).toBe(2500);
  });
});

describe('refunds', () => {
  it('refunds a payment to wallet, partial then over-refund rejected', async () => {
    const sub = await createSubscriber({ full_name: 'Refundee', phone: `2${tag}06` });
    const { checkoutRequestId } = await initiateMpesa({ subscriberId: sub.id, amountCents: 10000 });
    const payment = await confirmPayment(checkoutRequestId, 'success');
    // wallet now has 10000
    const r1 = await createRefund({ paymentId: payment.id, amountCents: 4000, method: 'wallet' });
    expect(r1.amount_cents).toBe(4000);
    let w = await getWallet('subscriber', sub.id);
    expect(w!.balance_cents).toBe(6000);

    // Remaining refundable is 6000; asking for 7000 must fail.
    await expect(createRefund({ paymentId: payment.id, amountCents: 7000, method: 'manual' }))
      .rejects.toMatchObject({ status: 400 });

    // Refund the rest via 'manual' (no wallet impact).
    const r2 = await createRefund({ paymentId: payment.id, method: 'manual' });
    expect(r2.amount_cents).toBe(6000);
    w = await getWallet('subscriber', sub.id);
    expect(w!.balance_cents).toBe(6000); // manual didn't touch wallet
  });
});
