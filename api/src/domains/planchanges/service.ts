import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getPlan } from '../plans/service.js';
import { createInvoice, chargeFromWallet, getInvoice, type Invoice } from '../billing/service.js';
import { issueCreditNote } from '../credits/service.js';
import { emit } from '../events/bus.js';

const DAY_MS = 86_400_000;

export interface PlanChangeResult {
  paid: boolean;
  reason?: string;
  direction: 'upgrade' | 'downgrade' | 'lateral';
  remaining_days: number;
  unused_credit_cents: number;
  new_charge_cents: number;
  net_cents: number; // > 0 charged, < 0 credited
  invoice?: Invoice;
  credit_note_number?: string;
}

/**
 * Change a subscriber's plan mid-cycle with proration. We value the unused
 * remainder of the current plan and the cost of the new plan over the same
 * remaining days, then settle the NET in a single money movement:
 *
 *   net = prorated(newPlan) - prorated(currentPlan over remaining days)
 *   net > 0  -> raise an invoice for the difference (+VAT) and charge wallet
 *   net < 0  -> issue a credit note for the difference (wallet credit)
 *
 * The plan only switches once the net is settled, so a failed upgrade charge
 * leaves the subscriber on their existing plan (no partial state).
 */
export async function changePlan(input: {
  subscriberId: string;
  newPlanId: string;
}): Promise<PlanChangeResult> {
  const subRow = await query(
    `SELECT * FROM subscriptions
     WHERE subscriber_id = $1 AND status = 'active'
     ORDER BY end_at DESC NULLS LAST LIMIT 1`,
    [input.subscriberId]
  );
  const sub = subRow.rows[0];
  if (!sub) throw badRequest('no active subscription to change — buy a plan instead');

  const currentPlan = await getPlan(sub.plan_id);
  const newPlan = await getPlan(input.newPlanId);
  if (currentPlan.id === newPlan.id) throw badRequest('already on this plan');

  const now = Date.now();
  const end = sub.end_at ? new Date(sub.end_at).getTime() : now;
  const remainingDays = Math.max(0, Math.ceil((end - now) / DAY_MS));
  const fraction = currentPlan.validity_days > 0
    ? Math.min(1, remainingDays / currentPlan.validity_days)
    : 0;

  const unusedCredit = Math.round(currentPlan.price_cents * fraction);
  const newCharge = Math.round(newPlan.price_cents * fraction);
  const net = newCharge - unusedCredit;
  const direction = net > 0 ? 'upgrade' : net < 0 ? 'downgrade' : 'lateral';

  const base: PlanChangeResult = {
    paid: true,
    direction,
    remaining_days: remainingDays,
    unused_credit_cents: unusedCredit,
    new_charge_cents: newCharge,
    net_cents: net,
  };

  let invoice: Invoice | undefined;
  let creditNoteNumber: string | undefined;

  if (net > 0) {
    invoice = await createInvoice(input.subscriberId, [
      { description: `Upgrade to ${newPlan.name} (prorated, ${remainingDays}d)`, unit_price_cents: net },
    ]);
    const result = await chargeFromWallet(invoice.id);
    if (!result.paid) {
      return { ...base, paid: false, reason: result.reason, invoice: await getInvoice(invoice.id) };
    }
    invoice = await getInvoice(invoice.id);
  } else if (net < 0) {
    const note = await issueCreditNote({
      subscriberId: input.subscriberId,
      amountCents: -net,
      reason: `Downgrade from ${currentPlan.name} to ${newPlan.name} (prorated, ${remainingDays}d)`,
    });
    creditNoteNumber = note.number;
  }

  // Net settled — switch the plan, keeping the current cycle end date.
  await query(`UPDATE subscriptions SET plan_id = $2 WHERE id = $1`, [sub.id, newPlan.id]);
  await emit('plan.changed', {
    subscriberId: input.subscriberId,
    fromPlanId: currentPlan.id,
    toPlanId: newPlan.id,
    direction,
    netCents: net,
  });

  return { ...base, invoice, credit_note_number: creditNoteNumber };
}

export { changePlan as default };
