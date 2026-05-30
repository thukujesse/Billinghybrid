import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { createPlan } from '../src/domains/plans/service.js';
import { createSubscriber } from '../src/domains/subscribers/service.js';
import { getOrCreateWallet, credit, getWallet } from '../src/domains/wallet/service.js';
import { activateForPlan } from '../src/domains/subscriptions/service.js';
import { changePlan } from '../src/domains/planchanges/service.js';

const tag = Date.now().toString().slice(-7);

beforeAll(async () => {
  await query(
    `INSERT INTO tax_rules (region, name, rate_bps, active)
     VALUES ('KE', 'VAT', 1600, TRUE)
     ON CONFLICT (region) WHERE active DO NOTHING`
  );
});
afterAll(async () => { await pool.end(); });

describe('plan change with proration', () => {
  it('upgrade charges the prorated difference + VAT from wallet', async () => {
    const sub = await createSubscriber({ full_name: 'Upgrader', phone: `3${tag}01` });
    const basic = await createPlan({ name: `Basic-${tag}`, type: 'prepaid', price_cents: 10000, validity_days: 30 });
    const pro = await createPlan({ name: `Pro-${tag}`, type: 'prepaid', price_cents: 15000, validity_days: 30 });
    await activateForPlan(sub.id, basic.id);

    const w = await getOrCreateWallet('subscriber', sub.id);
    await credit(w.id, 10000, 'topup');

    const r = await changePlan({ subscriberId: sub.id, newPlanId: pro.id });
    expect(r.direction).toBe('upgrade');
    expect(r.paid).toBe(true);
    // fraction ~1 just after activation: net = 15000 - 10000 = 5000; +16% VAT = 5800
    expect(r.net_cents).toBe(5000);
    const after = await getWallet('subscriber', sub.id);
    expect(after!.balance_cents).toBe(10000 - 5800);

    const subs = await query(`SELECT plan_id FROM subscriptions WHERE subscriber_id = $1`, [sub.id]);
    expect(subs.rows[0].plan_id).toBe(pro.id);
  });

  it('downgrade credits the prorated difference to the wallet', async () => {
    const sub = await createSubscriber({ full_name: 'Downgrader', phone: `3${tag}02` });
    const basic = await createPlan({ name: `Basic2-${tag}`, type: 'prepaid', price_cents: 10000, validity_days: 30 });
    const pro = await createPlan({ name: `Pro2-${tag}`, type: 'prepaid', price_cents: 15000, validity_days: 30 });
    await activateForPlan(sub.id, pro.id);

    const r = await changePlan({ subscriberId: sub.id, newPlanId: basic.id });
    expect(r.direction).toBe('downgrade');
    expect(r.net_cents).toBe(-5000);
    const w = await getWallet('subscriber', sub.id);
    expect(w!.balance_cents).toBe(5000); // credited
  });

  it('failed upgrade (no balance) leaves the subscriber on the current plan', async () => {
    const sub = await createSubscriber({ full_name: 'Broke Upgrader', phone: `3${tag}03` });
    const basic = await createPlan({ name: `Basic3-${tag}`, type: 'prepaid', price_cents: 10000, validity_days: 30 });
    const pro = await createPlan({ name: `Pro3-${tag}`, type: 'prepaid', price_cents: 15000, validity_days: 30 });
    await activateForPlan(sub.id, basic.id);

    const r = await changePlan({ subscriberId: sub.id, newPlanId: pro.id });
    expect(r.paid).toBe(false);
    const subs = await query(`SELECT plan_id FROM subscriptions WHERE subscriber_id = $1`, [sub.id]);
    expect(subs.rows[0].plan_id).toBe(basic.id); // unchanged
  });
});
