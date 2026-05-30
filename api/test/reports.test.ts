import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { createPlan } from '../src/domains/plans/service.js';
import { createSubscriber } from '../src/domains/subscribers/service.js';
import { activateForPlan } from '../src/domains/subscriptions/service.js';
import { topPlans, churnAndMrr, paymentsCsv } from '../src/domains/reports/service.js';

const tag = Date.now().toString().slice(-7);

afterAll(async () => { await pool.end(); });

describe('reports', () => {
  it('counts active subscriptions in top plans and computes MRR', async () => {
    const plan = await createPlan({ name: `Rpt-${tag}`, type: 'postpaid', price_cents: 300000, billing_cycle: 'monthly' });
    const sub = await createSubscriber({ full_name: 'Rpt User', phone: `8${tag}01` });
    await activateForPlan(sub.id, plan.id);

    const top = await topPlans(50);
    const mine = top.find((p) => p.name === `Rpt-${tag}`);
    expect(mine?.active_subs).toBeGreaterThanOrEqual(1);

    const cm = await churnAndMrr();
    expect(cm.mrr_cents).toBeGreaterThanOrEqual(300000);
    expect(typeof cm.churn_rate_pct).toBe('number');
  });

  it('exports payments as CSV with a header row', async () => {
    const csv = await paymentsCsv();
    expect(csv.split('\n')[0]).toBe('created_at,provider,amount,currency,status,reference');
  });
});
