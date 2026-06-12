import * as tenants from '../tenants/service.js';
import { generateInvoice, hasInvoice } from './billing.js';

// Month-end billing close: snapshot each tenant's platform charge for the just-
// ended month into tenant_invoice. Idempotent — only generates an invoice that
// doesn't exist yet, so re-running never overwrites a closed month's snapshot.
// (The /platform manual-generate endpoint is what re-snapshots on demand.)

function prevMonthPeriod(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7); // 'YYYY-MM'
}

async function closePriorMonth(): Promise<void> {
  const period = prevMonthPeriod();
  const all = await tenants.listTenants();
  for (const t of all) {
    try {
      if (!(await hasInvoice(t.id, period))) {
        await generateInvoice(t, period);
        console.log(`[billing-worker] invoiced ${t.slug} for ${period}`);
      }
    } catch (e) {
      console.error(`[billing-worker] failed ${t.slug} ${period}:`, e);
    }
  }
}

export const billingWorkerEnabled = (process.env.PLATFORM_BILLING_WORKER ?? 'true') !== 'false';
export const billingWorkerIntervalMs = Number(process.env.PLATFORM_BILLING_INTERVAL_MS ?? 12 * 3_600_000);

/** Start the periodic month-close. Runs once ~30s after boot, then on interval. */
export function startBillingWorker(intervalMs = billingWorkerIntervalMs): () => Promise<void> {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await closePriorMonth(); }
    catch (e) { console.error('[billing-worker] tick failed:', e); }
    finally { running = false; }
  };
  const first = setTimeout(tick, 30_000);
  first.unref();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  console.log(`[billing-worker] started (interval=${intervalMs}ms)`);
  return async () => { clearTimeout(first); clearInterval(timer); };
}
