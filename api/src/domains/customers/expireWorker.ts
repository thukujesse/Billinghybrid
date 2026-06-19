/**
 * Auto-expire worker for PPPoE services.
 *
 * Sweeps services whose expiry_date has passed and flips them to
 * status='expired'. setServiceStatus() inside expireDueServices()
 * handles the side-effects: re-syncs RADIUS reply attributes and pushes
 * the customer's framed-IP into jtm-expired on every managed MikroTik
 * so HTTP gets captive-redirected to /renew.
 *
 * Runs hourly by default — granularity finer than that costs more queries
 * than it's worth (a customer who pays at HH:55 still has up to ~5 min
 * buffer before being kicked, which is fine; the M-Pesa-callback path
 * restores them immediately when their payment lands).
 *
 * Disabled when WORKER_ENABLED=false (shared flag with the payment
 * worker — replicas that don't run jobs shouldn't run this either).
 */
import { config } from '../../config.js';
import { runWithTenant, currentTenantId } from '../../db/pool.js';
import { listTenants, poolForTenant } from '../tenants/service.js';
import { expireDueServices, notifyExpiringSoon } from './service.js';
import { autoRenewDue } from './wallet.js';
import { lowBalanceSweep } from './notifications.js';

export function startExpireWorker(intervalMs = 60 * 60 * 1000): () => Promise<void> {
  let stopping = false;
  let inFlight: Promise<void> | null = null;

  // One tenant's worth of sweeps, in order, within the caller's tenant context
  // (query() hits that tenant's DB). Each sweep is independently guarded so one
  // failure doesn't abort the rest. Order: wallet auto-renew FIRST (silent,
  // keeps the customer online), then STK dunning, low-balance + expiry SMS,
  // then the expire sweep for the past-due.
  const runSweeps = async () => {
    const tenant = currentTenantId();
    try {
      const renewed = await autoRenewDue(24);
      if (renewed.length > 0) {
        console.log(JSON.stringify({
          level: 'info', msg: 'auto_renew_sweep', tenant,
          count: renewed.length, total_kes: renewed.reduce((a, b) => a + b.amount_cents, 0) / 100,
        }));
      }
    } catch (err) { console.error(`[expire-worker:${tenant}] auto-renew sweep failed:`, (err as Error).message); }

    // Auto-STK renewal dunning (opt-in, OFF by default). Runs after autoRenewDue
    // so wallet customers are renewed silently first and never get an STK prompt.
    try {
      const { runStkDunningOnce } = await import('./dunning.js');
      const d = await runStkDunningOnce();
      if (d.fired > 0) console.log(JSON.stringify({ level: 'info', msg: 'stk_dunning_sweep', tenant, fired: d.fired, eligible: d.eligible }));
    } catch (err) { console.error(`[expire-worker:${tenant}] stk dunning failed:`, (err as Error).message); }

    try {
      const { warned } = await lowBalanceSweep(7 * 24);
      if (warned > 0) console.log(JSON.stringify({ level: 'info', msg: 'low_balance_sweep', tenant, count: warned }));
    } catch (err) { console.error(`[expire-worker:${tenant}] low-balance sweep failed:`, (err as Error).message); }

    try {
      const { warned } = await notifyExpiringSoon(24);
      if (warned > 0) console.log(JSON.stringify({ level: 'info', msg: 'expiry_warning_sweep', tenant, count: warned }));
    } catch (err) { console.error(`[expire-worker:${tenant}] warning sweep failed:`, (err as Error).message); }

    try {
      const expired = await expireDueServices();
      if (expired.length > 0) {
        console.log(JSON.stringify({
          level: 'info', msg: 'auto_expire_sweep', tenant,
          count: expired.length, services: expired.map((s) => ({ id: s.id, username: s.username })),
        }));
      }
    } catch (err) { console.error(`[expire-worker:${tenant}] expire sweep failed:`, (err as Error).message); }
  };

  const run = async () => {
    if (stopping || inFlight) return;
    inFlight = (async () => {
      try {
        // Multitenant: run the sweeps for EVERY active tenant, each in its own
        // DB context. listTenants() always hits the control DB. Falls back to a
        // single default-pool sweep when the registry is empty/unavailable (the
        // original single-tenant install).
        let tenants: Awaited<ReturnType<typeof listTenants>> = [];
        try { tenants = (await listTenants()).filter((t) => t.status === 'active'); }
        catch (e) { console.error('[expire-worker] listTenants failed; using default pool:', (e as Error).message); }
        console.log(JSON.stringify({ level: 'info', msg: 'expire_worker_run', tenants: tenants.length || 1 }));
        if (tenants.length === 0) {
          await runSweeps();
        } else {
          for (const t of tenants) {
            try {
              await runWithTenant({ tenantId: t.slug, pool: poolForTenant(t), uuid: t.id, status: t.status }, runSweeps);
            } catch (err) {
              console.error(`[expire-worker] tenant ${t.slug} sweep failed:`, (err as Error).message);
            }
          }
        }
      } catch (err) {
        console.error('[expire-worker] sweep failed:', (err as Error).message);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // Fire once on startup so a long-down service catches up quickly,
  // then settle into the interval cadence.
  setTimeout(run, 30_000).unref();
  const tick = setInterval(run, intervalMs);
  tick.unref();

  return async () => {
    stopping = true;
    clearInterval(tick);
    if (inFlight) await inFlight;
  };
}

// Read interval from env so ops can tune without a redeploy.
export const expireWorkerIntervalMs = (() => {
  const env = process.env.EXPIRE_WORKER_INTERVAL_MS;
  if (!env) return 60 * 60 * 1000;
  const n = Number(env);
  return Number.isFinite(n) && n >= 60_000 ? n : 60 * 60 * 1000;
})();

export const expireWorkerEnabled = config.paymentQueue.enabled;