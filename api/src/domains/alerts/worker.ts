/**
 * Alert sweep worker. Runs every 5 minutes — fast enough that operators
 * hear about problems within minutes, slow enough that a flapping
 * condition doesn't spam Telegram. Shares WORKER_ENABLED with the
 * payment + expire workers so replicas without job execution stay quiet.
 *
 * Skips its own tick if the previous run is still in-flight (long
 * evaluator + slow Telegram fan-out shouldn't pile up).
 */
import { config } from '../../config.js';
import { currentTenantId } from '../../db/pool.js';
import { runEvaluators } from './service.js';
import { eachTenant } from '../tenants/service.js';

export function startAlertWorker(intervalMs = 5 * 60 * 1000): () => Promise<void> {
  let stopping = false;
  let inFlight: Promise<void> | null = null;

  const run = async () => {
    if (stopping || inFlight) return;
    inFlight = (async () => {
      try {
        // Evaluate EVERY active tenant's conditions in its own DB context — a
        // no-context sweep would only watch the default tenant, so isolated
        // tenants' offline routers / queue backlogs would never alert.
        await eachTenant(async () => {
          const { opened, resolved } = await runEvaluators();
          if (opened.length > 0 || resolved.length > 0) {
            console.log(JSON.stringify({
              level: 'info', msg: 'alert_sweep', tenant: currentTenantId(),
              opened: opened.map((a) => ({ kind: a.kind, key: a.dedup_key })),
              resolved: resolved.map((a) => ({ kind: a.kind, key: a.dedup_key })),
            }));
          }
        }, 'alert-worker');
      } catch (err) {
        console.error('[alert-worker] sweep failed:', (err as Error).message);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // First tick 60s after boot so DB pools + migrations have settled.
  setTimeout(run, 60_000).unref();
  const tick = setInterval(run, intervalMs);
  tick.unref();

  return async () => {
    stopping = true;
    clearInterval(tick);
    if (inFlight) await inFlight;
  };
}

export const alertWorkerEnabled = config.paymentQueue.enabled;
export const alertWorkerIntervalMs = (() => {
  const env = process.env.ALERT_WORKER_INTERVAL_MS;
  if (!env) return 5 * 60 * 1000;
  const n = Number(env);
  return Number.isFinite(n) && n >= 60_000 ? n : 5 * 60 * 1000;
})();
