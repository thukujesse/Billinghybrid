/**
 * Payment events worker. Runs inside the API process (not a separate
 * daemon) — keeps deploys, env, and DB pool sharing trivial at small
 * scale. Started from server.ts; gated by config.paymentQueue.enabled.
 *
 * Each tick:
 *   1. Reap stale locks (rows stuck in 'processing' past staleLockMs)
 *   2. Claim up to batchSize due jobs (SKIP LOCKED)
 *   3. Dispatch by source; markSuccess() or markFailure() per job
 *
 * Dispatcher routes by the source field — adding a new payment provider
 * means: add an enum value at the call site + a case here. The handler
 * functions (handleDarajaCallback, confirmPayment, completePurchase) are
 * already idempotent on status != 'pending', so a re-run after partial
 * settle is a no-op.
 */
import { hostname } from 'node:os';
import { config } from '../../config.js';
import { parseCallback } from '../payments/daraja.js';
import * as hotspot from '../hotspot/service.js';
import * as payments from '../payments/service.js';
import {
  claimBatch,
  markSuccess,
  markFailure,
  reapStaleLocks,
  type PaymentEvent,
} from './service.js';

const WORKER_ID = `${hostname()}#${process.pid}`;
// Reap stale locks less often than poll — once every N ticks.
const REAP_EVERY_N_TICKS = 30;

async function dispatch(job: PaymentEvent): Promise<void> {
  switch (job.source) {
    case 'mpesa_hotspot': {
      // Daraja STK callback for a hotspot purchase. handleDarajaCallback
      // parses + routes to completePurchase, which is idempotent.
      const handled = await hotspot.handleDarajaCallback(job.payload);
      if (!handled) {
        throw new Error(`mpesa_hotspot: callback shape not parseable (dedup=${job.dedup_key})`);
      }
      return;
    }
    case 'mpesa_payment': {
      // Daraja STK callback for a subscriber payment.
      const parsed = parseCallback(job.payload);
      if (!parsed) {
        throw new Error(`mpesa_payment: callback shape not parseable (dedup=${job.dedup_key})`);
      }
      await payments.confirmPayment(
        parsed.checkoutRequestId,
        parsed.success ? 'success' : 'failed',
        job.payload as Record<string, unknown>
      );
      return;
    }
    case 'manual_hotspot': {
      // Simulation-only path (no Daraja creds). Payload: { checkoutRequestId }
      const cr = (job.payload as any)?.checkoutRequestId;
      if (!cr) throw new Error('manual_hotspot: missing checkoutRequestId in payload');
      await hotspot.completePurchase({
        checkoutRequestId: cr,
        success: true,
        receipt: 'SIMULATED',
      });
      return;
    }
    default:
      throw new Error(`unknown source: ${job.source}`);
  }
}

async function processBatch(): Promise<number> {
  const batch = await claimBatch(WORKER_ID, config.paymentQueue.batchSize);
  if (batch.length === 0) return 0;
  for (const job of batch) {
    try {
      await dispatch(job);
      await markSuccess(job.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[payment-worker] job ${job.id} (${job.source}) failed:`, msg);
      try {
        await markFailure(job.id, msg);
      } catch (e2) {
        console.error('[payment-worker] markFailure itself failed:', e2);
      }
    }
  }
  return batch.length;
}

/**
 * Start the worker. Returns a stop function that drains the in-flight tick
 * and resolves; safe to call multiple times. server.ts awaits it during
 * graceful shutdown so we don't kill a job mid-settle.
 */
export function startPaymentWorker(): () => Promise<void> {
  let stopRequested = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  let tickCount = 0;

  const tick = async () => {
    if (stopRequested) return;
    tickCount++;
    try {
      if (tickCount % REAP_EVERY_N_TICKS === 0) {
        const reaped = await reapStaleLocks();
        if (reaped > 0) console.log(`[payment-worker] reaped ${reaped} stale lock(s)`);
      }
      await processBatch();
    } catch (err) {
      console.error('[payment-worker] tick error:', err);
    }
  };

  const interval = setInterval(() => {
    if (stopRequested) return;
    inFlight = tick();
  }, config.paymentQueue.intervalMs);
  interval.unref();

  console.log(`[payment-worker] started (id=${WORKER_ID}, interval=${config.paymentQueue.intervalMs}ms)`);

  return async () => {
    stopRequested = true;
    clearInterval(interval);
    await inFlight; // let the current tick finish
    console.log('[payment-worker] stopped');
  };
}
