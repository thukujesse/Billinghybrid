import { getPlan } from '../plans/service.js';
import { getSubscriber } from '../subscribers/service.js';
import { createInvoice, chargeFromWallet, getInvoice, type Invoice } from '../billing/service.js';
import { activateForPlan } from '../subscriptions/service.js';
import { emit } from '../events/bus.js';

/**
 * Buy a plan and activate it, paying from the buyer's wallet ("Buy Plan" +
 * "Buy Plan for Friend"). An invoice (with VAT) is raised against the buyer
 * and settled from their wallet; on success the plan is activated for the
 * recipient (the buyer unless `recipientId` is given).
 *
 * To pay by M-Pesa instead, top the wallet up first (STK push) and then buy —
 * the wallet is the single settlement surface, which keeps the ledger clean.
 */
export async function buyPlan(input: {
  buyerId: string;
  planId: string;
  recipientId?: string;
}): Promise<{
  paid: boolean;
  reason?: string;
  invoice: Invoice;
  subscriptionId?: string;
  gifted: boolean;
}> {
  const recipientId = input.recipientId ?? input.buyerId;
  const plan = await getPlan(input.planId);
  await getSubscriber(input.buyerId);
  if (recipientId !== input.buyerId) await getSubscriber(recipientId);

  const gifted = recipientId !== input.buyerId;
  const label = gifted ? `${plan.name} (gift)` : plan.name;

  const invoice = await createInvoice(input.buyerId, [
    { description: label, unit_price_cents: plan.price_cents },
  ]);

  const result = await chargeFromWallet(invoice.id);
  if (!result.paid) {
    return { paid: false, reason: result.reason, invoice: await getInvoice(invoice.id), gifted };
  }

  const subscription = await activateForPlan(recipientId, input.planId);
  await emit('plan.purchased', {
    buyerId: input.buyerId,
    recipientId,
    planId: input.planId,
    invoiceId: invoice.id,
    gifted,
  });

  return { paid: true, invoice: await getInvoice(invoice.id), subscriptionId: subscription.id, gifted };
}
