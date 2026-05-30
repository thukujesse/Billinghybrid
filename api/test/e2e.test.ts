import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { pool, query } from '../src/db/pool.js';

/**
 * Full-stack e2e: boots the real Express app (all routes, middleware, plugins,
 * metrics) on an ephemeral port and drives it over HTTP, exercising a complete
 * subscriber journey end to end.
 */

let server: Server;
let base: string;
const tag = Date.now().toString().slice(-7);

async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON (pdf/csv/metrics) */ }
  return { status: res.status, json, text, headers: res.headers };
}

beforeAll(async () => {
  await query(
    `INSERT INTO tax_rules (region, name, rate_bps, active)
     VALUES ('KE', 'VAT', 1600, TRUE)
     ON CONFLICT (region) WHERE active DO NOTHING`
  );
  const app = await createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('e2e: health, metrics, plugins', () => {
  it('serves health, prometheus metrics, and the plugin list', async () => {
    expect((await http('GET', '/health')).json.ok).toBe(true);

    const metrics = await http('GET', '/metrics');
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(metrics.text).toContain('jtm_http_requests_total');

    const plugins = await http('GET', '/api/plugins');
    expect(Array.isArray(plugins.json)).toBe(true);
    expect(plugins.json.some((p: any) => p.manifest.id === 'loyalty-points')).toBe(true);
  });
});

describe('e2e: full subscriber journey', () => {
  it('register -> plan -> M-Pesa top-up -> buy plan -> invoice PDF -> loyalty', async () => {
    // 1. Create a plan
    const plan = await http('POST', '/api/plans', {
      name: `E2E ${tag}`, type: 'prepaid', price_cents: 20000, validity_days: 30, data_cap_mb: 5120,
    });
    expect(plan.status).toBe(201);

    // 2. Register a subscriber
    const sub = await http('POST', '/api/subscribers', { full_name: 'E2E User', phone: `9${tag}90` });
    expect(sub.status).toBe(201);
    const subId = sub.json.id;

    // 3. M-Pesa top-up (simulation): STK then callback
    const stk = await http('POST', '/api/payments/mpesa/stk', { subscriber_id: subId, amount_cents: 30000 });
    expect(stk.status).toBe(201);
    await http('POST', '/api/payments/mpesa/callback', { checkout_request_id: stk.json.checkoutRequestId, outcome: 'success' });

    const wallet = await http('GET', `/api/subscribers/${subId}/wallet`);
    expect(wallet.json.balance_cents).toBe(30000);

    // 4. Buy the plan from wallet (price + VAT = 20000 + 3200 = 23200)
    const buy = await http('POST', `/api/subscribers/${subId}/buy-plan`, { plan_id: plan.json.id });
    expect(buy.json.paid).toBe(true);
    const afterBuy = await http('GET', `/api/subscribers/${subId}/wallet`);
    expect(afterBuy.json.balance_cents).toBe(30000 - 23200);

    // 5. The buy created an invoice — fetch its PDF
    const invoices = await http('GET', `/api/subscribers/${subId}/invoices`);
    expect(invoices.json.length).toBeGreaterThanOrEqual(1);
    const pdf = await http('GET', `/api/invoices/${invoices.json[0].id}/pdf`);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    expect(pdf.text.startsWith('%PDF-')).toBe(true);

    // 6. Loyalty plugin awarded points on payment.paid (KES 300 -> 3 points)
    const loyalty = await http('GET', `/api/ext/loyalty-points/${subId}`);
    expect(loyalty.json.points).toBe(3);

    // 7. Subscriber is active with a subscription
    const full = await http('GET', `/api/subscribers/${subId}`);
    expect(full.json.status).toBe('active');
    expect(full.json.subscriptions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('e2e: validation and not-found', () => {
  it('rejects an invalid body with 422 and unknown route with 404', async () => {
    const bad = await http('POST', '/api/subscribers', { full_name: '' });
    expect(bad.status).toBe(422);
    const missing = await http('GET', '/api/nope');
    expect(missing.status).toBe(404);
  });
});
