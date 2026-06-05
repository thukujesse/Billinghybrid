/**
 * Network metrics sampler. Runs every 60 seconds and writes one row
 * per managed router into router_metrics. Cheap (single SQL insert
 * with a join, scales linearly with router count).
 *
 * The /network UI's bandwidth chart and the per-router rate-bps
 * computation both depend on these samples — without the worker
 * running, those graphs and the "live throughput" tile stay empty.
 *
 * Shares WORKER_ENABLED with the payment + expire + alert workers.
 */
import { config } from '../../config.js';
import { captureSample } from './service.js';

export function startMetricsWorker(intervalMs = 60_000): () => Promise<void> {
  let stopping = false;
  let inFlight: Promise<void> | null = null;

  const run = async () => {
    if (stopping || inFlight) return;
    inFlight = (async () => {
      try {
        await captureSample();
      } catch (err) {
        console.error('[metrics-worker] sample failed:', (err as Error).message);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // First tick 15s after boot so DB is warm.
  setTimeout(run, 15_000).unref();
  const tick = setInterval(run, intervalMs);
  tick.unref();

  return async () => {
    stopping = true;
    clearInterval(tick);
    if (inFlight) await inFlight;
  };
}

export const metricsWorkerEnabled = config.paymentQueue.enabled;
export const metricsWorkerIntervalMs = (() => {
  const env = process.env.METRICS_WORKER_INTERVAL_MS;
  if (!env) return 60_000;
  const n = Number(env);
  return Number.isFinite(n) && n >= 30_000 ? n : 60_000;
})();
