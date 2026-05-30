import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { invoiceNumber } from '../../lib/codes.js';
import { notFound } from '../../lib/errors.js';
import { computeTax } from '../tax/service.js';
import { getPlan } from '../plans/service.js';
import { dueForBilling } from '../subscriptions/service.js';
import { getOrCreateWallet, debit } from '../wallet/service.js';
import { provisioning } from '../provisioning/service.js';
import { emit } from '../events/bus.js';

export interface Invoice {
  id: string;
  number: string;
  subscriber_id: string;
  subscription_id: string | null;
  status: 'draft' | 'open' | 'paid' | 'void' | 'overdue';
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  due_date: string;
  issued_at: string;
  paid_at: string | null;
  dunning_attempts: number;
}

interface LineInput {
  description: string;
  quantity?: number;
  unit_price_cents: number;
}

/**
 * Create an invoice for a subscriber from a set of line items, applying the
 * region's tax rule. The invoice opens as 'open' and is due in `graceDays`.
 */
export async function createInvoice(
  subscriberId: string,
  lines: LineInput[],
  opts: { subscriptionId?: string; region?: string } = {},
  client?: PoolClient
): Promise<Invoice> {
  const run = async (c: PoolClient) => {
    let subtotal = 0;
    const prepared = lines.map((l) => {
      const qty = l.quantity ?? 1;
      const amount = qty * l.unit_price_cents;
      subtotal += amount;
      return { ...l, qty, amount };
    });

    const { taxCents, rateBps } = await computeTax(subtotal, opts.region);
    const total = subtotal + taxCents;
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + config.dunning.graceDays);

    const inv = await c.query<Invoice>(
      `INSERT INTO invoices
         (number, subscriber_id, subscription_id, status, subtotal_cents, tax_cents, total_cents, currency, due_date)
       VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8)
       RETURNING *`,
      [invoiceNumber(), subscriberId, opts.subscriptionId ?? null, subtotal, taxCents, total, config.currency, due.toISOString()]
    );
    const invoice = inv.rows[0];

    for (const p of prepared) {
      await c.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, amount_cents, tax_rate_bps)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoice.id, p.description, p.qty, p.unit_price_cents, p.amount, rateBps]
      );
    }

    await emit('invoice.created', { invoiceId: invoice.id, subscriberId, total });
    return invoice;
  };
  return client ? run(client) : withTransaction(run);
}

export async function getInvoice(id: string): Promise<Invoice & { items: any[] }> {
  const r = await query<Invoice>('SELECT * FROM invoices WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('invoice');
  const items = await query('SELECT * FROM invoice_items WHERE invoice_id = $1', [id]);
  return { ...r.rows[0], items: items.rows };
}

export async function listInvoices(subscriberId?: string): Promise<Invoice[]> {
  const r = subscriberId
    ? await query<Invoice>('SELECT * FROM invoices WHERE subscriber_id = $1 ORDER BY issued_at DESC', [subscriberId])
    : await query<Invoice>('SELECT * FROM invoices ORDER BY issued_at DESC LIMIT 200');
  return r.rows;
}

/** Mark an invoice paid and emit the event (idempotent on already-paid). */
export async function markPaid(invoiceId: string, client?: PoolClient): Promise<Invoice> {
  const run = async (c: PoolClient) => {
    const r = await c.query<Invoice>(
      `UPDATE invoices SET status = 'paid', paid_at = now()
       WHERE id = $1 AND status != 'paid' RETURNING *`,
      [invoiceId]
    );
    if (r.rows[0]) {
      await emit('invoice.paid', { invoiceId, subscriberId: r.rows[0].subscriber_id });
    }
    return r.rows[0] ?? (await getInvoice(invoiceId));
  };
  return client ? run(client) : withTransaction(run);
}

/**
 * Attempt to settle an open invoice from the subscriber's wallet
 * ("Auto-Renewal from Balance"). Returns whether it was paid.
 */
export async function chargeFromWallet(invoiceId: string): Promise<{ paid: boolean; reason?: string }> {
  return withTransaction(async (c) => {
    const r = await c.query<Invoice>(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
    const invoice = r.rows[0];
    if (!invoice) throw notFound('invoice');
    if (invoice.status === 'paid') return { paid: true };

    const wallet = await getOrCreateWallet('subscriber', invoice.subscriber_id, c);
    if (wallet.balance_cents < invoice.total_cents) {
      return { paid: false, reason: 'insufficient_balance' };
    }
    await debit(wallet.id, invoice.total_cents, `Invoice ${invoice.number}`, { type: 'invoice', id: invoice.id }, c);
    await markPaid(invoice.id, c);
    // Ensure network access is on after payment.
    await provisioning.restore(invoice.subscriber_id, { via: 'wallet_payment' });
    return { paid: true };
  });
}

/**
 * Monthly auto-billing run (Data Flow 02). For each due postpaid
 * subscription: generate an invoice, try to charge the wallet; on success the
 * cycle rolls forward. Returns a summary.
 */
export async function runBillingCycle(): Promise<{
  invoiced: number;
  paid: number;
  unpaid: number;
}> {
  const due = await dueForBilling();
  let invoiced = 0;
  let paid = 0;
  let unpaid = 0;

  for (const sub of due) {
    const plan = await getPlan(sub.plan_id);
    const invoice = await createInvoice(
      sub.subscriber_id,
      [{ description: `${plan.name} — monthly`, unit_price_cents: plan.price_cents }],
      { subscriptionId: sub.id }
    );
    invoiced++;

    const result = await chargeFromWallet(invoice.id);
    if (result.paid) {
      paid++;
      // Roll the subscription window forward by the plan validity.
      const end = new Date();
      end.setUTCDate(end.getUTCDate() + plan.validity_days);
      await query(`UPDATE subscriptions SET end_at = $2 WHERE id = $1`, [sub.id, end.toISOString()]);
    } else {
      unpaid++;
    }
  }
  await emit('billing.cycle.completed', { invoiced, paid, unpaid });
  return { invoiced, paid, unpaid };
}

/**
 * Dunning run (Flow 02 failure path). Open invoices past due get a strike;
 * after `maxAttempts` the subscriber is suspended. Returns counts.
 */
export async function runDunning(): Promise<{ retried: number; suspended: number }> {
  const overdue = await query<Invoice>(
    `SELECT * FROM invoices WHERE status IN ('open','overdue') AND due_date < now()`
  );
  let retried = 0;
  let suspended = 0;

  for (const inv of overdue.rows) {
    const result = await chargeFromWallet(inv.id);
    if (result.paid) continue;

    const attempts = inv.dunning_attempts + 1;
    await query(
      `UPDATE invoices SET dunning_attempts = $2, status = 'overdue' WHERE id = $1`,
      [inv.id, attempts]
    );
    retried++;
    await emit('invoice.dunning', { invoiceId: inv.id, attempt: attempts });

    if (attempts >= config.dunning.maxAttempts) {
      await query(`UPDATE subscribers SET status = 'suspended' WHERE id = $1`, [inv.subscriber_id]);
      await query(`UPDATE subscriptions SET status = 'suspended' WHERE subscriber_id = $1 AND status = 'active'`, [inv.subscriber_id]);
      await provisioning.suspend(inv.subscriber_id, { reason: 'dunning_exhausted', invoiceId: inv.id });
      await emit('subscriber.suspended', { subscriberId: inv.subscriber_id, reason: 'dunning' });
      suspended++;
    }
  }
  return { retried, suspended };
}
