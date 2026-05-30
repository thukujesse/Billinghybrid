import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { createPlan } from '../src/domains/plans/service.js';
import { createSubscriber } from '../src/domains/subscribers/service.js';
import { createInvoice } from '../src/domains/billing/service.js';
import { getInvoicePdf } from '../src/domains/billing/invoicePdf.js';
import * as storage from '../src/domains/storage/service.js';

const tag = Date.now().toString().slice(-7);

beforeAll(async () => {
  await query(
    `INSERT INTO tax_rules (region, name, rate_bps, active)
     VALUES ('KE', 'VAT', 1600, TRUE)
     ON CONFLICT (region) WHERE active DO NOTHING`
  );
});
afterAll(async () => { await pool.end(); });

describe('invoice PDF', () => {
  it('renders a valid PDF and persists it to object storage', async () => {
    const sub = await createSubscriber({ full_name: 'PDF User', phone: `6${tag}01` });
    const plan = await createPlan({ name: `PDF-${tag}`, type: 'postpaid', price_cents: 250000, billing_cycle: 'monthly' });
    const invoice = await createInvoice(sub.id, [{ description: plan.name, unit_price_cents: plan.price_cents }]);

    const { buffer, filename } = await getInvoicePdf(invoice.id);
    // Valid PDF header + trailer
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.subarray(-6).toString('latin1')).toContain('EOF');
    expect(filename).toBe(`${invoice.number}.pdf`);

    // Stored under the object-storage key and served identically on re-fetch.
    expect(await storage.exists(`invoices/${invoice.number}.pdf`)).toBe(true);
    const again = await getInvoicePdf(invoice.id);
    expect(again.buffer.length).toBe(buffer.length);
  });
});
