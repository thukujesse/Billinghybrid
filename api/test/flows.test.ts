import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { createPlan } from '../src/domains/plans/service.js';
import { createSubscriber, getSubscriber } from '../src/domains/subscribers/service.js';
import { createReseller } from '../src/domains/resellers/service.js';
import { getOrCreateWallet, credit, getWallet } from '../src/domains/wallet/service.js';
import { createInvoice, chargeFromWallet, runDunning } from '../src/domains/billing/service.js';
import { generateBatch, redeem } from '../src/domains/vouchers/service.js';
import { ingestUsage } from '../src/domains/usage/service.js';
import { initiateMpesa, confirmPayment } from '../src/domains/payments/service.js';

// Unique phone numbers per run to avoid UNIQUE collisions.
const tag = Date.now().toString().slice(-7);

beforeAll(async () => {
  await query(
    `INSERT INTO tax_rules (region, name, rate_bps, active)
     VALUES ('KE', 'VAT', 1600, TRUE)
     ON CONFLICT (region) WHERE active DO NOTHING`
  );
});

afterAll(async () => {
  await pool.end();
});

describe('wallet ledger', () => {
  it('credits then debits and keeps balance non-negative', async () => {
    const sub = await createSubscriber({ full_name: 'Ledger Test', phone: `1${tag}01` });
    const w = await getOrCreateWallet('subscriber', sub.id);
    await credit(w.id, 1000, 'top up');
    const after = await getWallet('subscriber', sub.id);
    expect(after!.balance_cents).toBe(1000);
  });
});

describe('invoice + tax + wallet payment', () => {
  it('creates an invoice with 16% VAT and settles from wallet', async () => {
    const sub = await createSubscriber({ full_name: 'Invoice Test', phone: `1${tag}02` });
    const plan = await createPlan({ name: `T-Post-${tag}`, type: 'postpaid', price_cents: 100000, billing_cycle: 'monthly' });
    const invoice = await createInvoice(sub.id, [{ description: plan.name, unit_price_cents: plan.price_cents }]);
    expect(invoice.subtotal_cents).toBe(100000);
    expect(invoice.tax_cents).toBe(16000);
    expect(invoice.total_cents).toBe(116000);

    // Not enough balance yet.
    let result = await chargeFromWallet(invoice.id);
    expect(result.paid).toBe(false);

    const w = await getOrCreateWallet('subscriber', sub.id);
    await credit(w.id, 116000, 'top up');
    result = await chargeFromWallet(invoice.id);
    expect(result.paid).toBe(true);

    const wallet = await getWallet('subscriber', sub.id);
    expect(wallet!.balance_cents).toBe(0);
  });
});

describe('reseller voucher batch + redeem', () => {
  it('debits reseller balance, then redeem activates a subscription', async () => {
    const reseller = await createReseller({ name: `R-${tag}`, phone: `1${tag}03`, commission_bps: 1000 });
    const rw = await getOrCreateWallet('reseller', reseller.id);
    const plan = await createPlan({ name: `T-Prepaid-${tag}`, type: 'prepaid', price_cents: 5000, validity_days: 7, data_cap_mb: 1024 });

    // No float -> batch generation must fail with payment_required.
    await expect(generateBatch({ planId: plan.id, quantity: 3, resellerId: reseller.id }))
      .rejects.toMatchObject({ status: 402 });

    await credit(rw.id, 100000, 'float');
    const { vouchers } = await generateBatch({ planId: plan.id, quantity: 3, resellerId: reseller.id, prefix: 'WST' });
    expect(vouchers).toHaveLength(3);

    const balAfter = await getWallet('reseller', reseller.id);
    expect(balAfter!.balance_cents).toBe(100000 - 3 * 5000);

    const sub = await createSubscriber({ full_name: 'Redeemer', phone: `1${tag}04` });
    const { subscriptionId } = await redeem(vouchers[0].code, sub.id);
    expect(subscriptionId).toBeTruthy();

    const fresh = await getSubscriber(sub.id);
    expect(fresh.status).toBe('active');

    // Commission credited to reseller (10% of 5000 = 500).
    const commissioned = await getWallet('reseller', reseller.id);
    expect(commissioned!.balance_cents).toBe(100000 - 3 * 5000 + 500);

    // Double-redeem is rejected.
    await expect(redeem(vouchers[0].code, sub.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('M-Pesa payment (simulated) is idempotent', () => {
  it('confirming twice credits the wallet once', async () => {
    const sub = await createSubscriber({ full_name: 'Mpesa Test', phone: `1${tag}05` });
    const { checkoutRequestId } = await initiateMpesa({ subscriberId: sub.id, amountCents: 30000 });
    await confirmPayment(checkoutRequestId, 'success');
    await confirmPayment(checkoutRequestId, 'success'); // replayed callback
    const w = await getWallet('subscriber', sub.id);
    expect(w!.balance_cents).toBe(30000);
  });
});

describe('FUP enforcement', () => {
  it('throttles when usage exceeds the data cap', async () => {
    const sub = await createSubscriber({ full_name: 'FUP Test', phone: `1${tag}06` });
    const plan = await createPlan({ name: `T-Cap-${tag}`, type: 'prepaid', price_cents: 1000, validity_days: 7, data_cap_mb: 1, fup_threshold_pct: 80 });
    // activate via a voucher path: just subscribe directly through redeem-less helper
    const { activateForPlan } = await import('../src/domains/subscriptions/service.js');
    await activateForPlan(sub.id, plan.id);

    // 1 MB cap. Push 0.9 MB -> alert, then over 1 MB -> throttle.
    const alert = await ingestUsage({ subscriberId: sub.id, bytesIn: 900 * 1024, bytesOut: 0 });
    expect(alert.action).toBe('alert');
    const throttle = await ingestUsage({ subscriberId: sub.id, bytesIn: 300 * 1024, bytesOut: 0 });
    expect(throttle.action).toBe('throttle');
  });
});

describe('dunning suspends after max attempts', () => {
  it('marks overdue and suspends', async () => {
    const sub = await createSubscriber({ full_name: 'Dunning Test', phone: `1${tag}07` });
    const plan = await createPlan({ name: `T-Dun-${tag}`, type: 'postpaid', price_cents: 50000, billing_cycle: 'monthly' });
    const invoice = await createInvoice(sub.id, [{ description: plan.name, unit_price_cents: plan.price_cents }]);
    // Force it past due.
    await query(`UPDATE invoices SET due_date = now() - interval '1 day' WHERE id = $1`, [invoice.id]);

    // Run dunning 3 times (DUNNING_MAX_ATTEMPTS default 3) with no balance.
    await runDunning();
    await runDunning();
    await runDunning();

    const fresh = await getSubscriber(sub.id);
    expect(fresh.status).toBe('suspended');
  });
});
