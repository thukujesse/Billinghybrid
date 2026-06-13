import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { setTenantStatus } from '../tenants/service.js';
import { collect } from './collection.js';

// ---------------------------------------------------------------------------
// Platform dunning: hands-off collection of overdue platform invoices. Past the
// grace period it STK-pushes the ISP once per run up to maxAttempts, then
// auto-suspends. DEFAULT OFF (config.control.dunning.enabled) — it moves real
// money, so the operator opts in. findDunningTargets() is side-effect-free so
// it can be previewed before enabling.
// ---------------------------------------------------------------------------

export interface DunningTarget {
  invoice_id: string; tenant_id: string; period: string; slug: string;
  contact_phone: string | null; tenant_status: string;
  attempts: number; last_attempt: string | null; amount_cents: number;
}

export async function findDunningTargets(): Promise<{ toCollect: DunningTarget[]; toSuspend: DunningTarget[] }> {
  const { graceDays, maxAttempts, intervalHours } = config.control.dunning;
  const r = await pool.query<DunningTarget>(
    `SELECT i.id AS invoice_id, i.tenant_id, i.period, t.slug, t.contact_phone,
            t.status AS tenant_status, i.total_cents AS amount_cents,
            (SELECT count(*) FROM platform_collection pc WHERE pc.invoice_id=i.id)::int AS attempts,
            (SELECT max(pc.created_at) FROM platform_collection pc WHERE pc.invoice_id=i.id) AS last_attempt
       FROM tenant_invoice i JOIN tenant t ON t.id=i.tenant_id
      WHERE i.status='issued' AND i.total_cents>0
        AND i.issued_at < now() - ($1 || ' days')::interval
        AND t.status = 'active'`,
    [graceDays]
  );
  const intervalMs = intervalHours * 3_600_000;
  const now = Date.now();
  const toCollect: DunningTarget[] = [];
  const toSuspend: DunningTarget[] = [];
  for (const row of r.rows) {
    if (row.attempts >= maxAttempts) { toSuspend.push(row); continue; }
    if (!row.contact_phone) continue; // can't STK — left for manual collection
    const last = row.last_attempt ? new Date(row.last_attempt).getTime() : 0;
    if (now - last >= intervalMs) toCollect.push(row); // space attempts by one run
  }
  return { toCollect, toSuspend };
}

export async function runDunningOnce(): Promise<{ collected: number; suspended: number }> {
  const { toCollect, toSuspend } = await findDunningTargets();
  let collected = 0, suspended = 0;
  for (const row of toCollect) {
    try { await collect(row.tenant_id, row.period); collected++; console.log(`[dunning] STK ${row.slug} for ${row.period}`); }
    catch (e) { console.error(`[dunning] collect ${row.slug} failed:`, (e as Error).message); }
  }
  for (const row of toSuspend) {
    try { await setTenantStatus(row.tenant_id, 'suspended'); suspended++; console.log(`[dunning] suspended ${row.slug} (max attempts, unpaid ${row.period})`); }
    catch (e) { console.error(`[dunning] suspend ${row.slug} failed:`, (e as Error).message); }
  }
  return { collected, suspended };
}

export const dunningEnabled = config.control.dunning.enabled;
export const dunningIntervalMs = config.control.dunning.intervalHours * 3_600_000;

export function startPlatformDunning(intervalMs = dunningIntervalMs): () => Promise<void> {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runDunningOnce();
      if (r.collected || r.suspended) console.log(`[dunning] run: ${r.collected} collected, ${r.suspended} suspended`);
    } catch (e) { console.error('[dunning] tick failed:', e); }
    finally { running = false; }
  };
  const first = setTimeout(tick, 60_000);
  first.unref();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  console.log(`[dunning] started (interval=${intervalMs}ms)`);
  return async () => { clearTimeout(first); clearInterval(timer); };
}
