import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { pollVpsHandshakes } from './domains/routers/service.js';
import { startPaymentWorker } from './domains/paymentEvents/worker.js';
import { startExpireWorker, expireWorkerEnabled, expireWorkerIntervalMs } from './domains/customers/expireWorker.js';
import { startAlertWorker, alertWorkerEnabled, alertWorkerIntervalMs } from './domains/alerts/worker.js';
import { startMetricsWorker, metricsWorkerEnabled, metricsWorkerIntervalMs } from './domains/network/worker.js';

const app = await createApp();

// Heartbeat loop: pull WG peer handshake state from the VPS every 30s so the
// dashboard can show live VPN status without admins refreshing manually. Quiet
// failure mode — wg-manager being down just means stale data, not crash.
const heartbeatInterval = setInterval(() => {
  pollVpsHandshakes().catch((err) =>
    console.error('[heartbeat] unhandled:', err)
  );
}, 30_000);
heartbeatInterval.unref();

// Payment events worker — drains the Daraja-callback queue asynchronously.
// Disabled with WORKER_ENABLED=false on replicas that shouldn't run jobs.
const stopPaymentWorker = config.paymentQueue.enabled
  ? startPaymentWorker()
  : async () => {};

// PPPoE expiry sweeper — hourly job that flips status to 'expired' when
// expiry_date < now() and pushes affected IPs into jtm-expired on every
// MikroTik. Shares WORKER_ENABLED with the payment worker.
const stopExpireWorker = expireWorkerEnabled
  ? startExpireWorker(expireWorkerIntervalMs)
  : async () => {};

// Operator alert engine — every 5 min, evaluate DLQ / queue backlog /
// router offline and fire Telegram to the admin chat on new conditions.
const stopAlertWorker = alertWorkerEnabled
  ? startAlertWorker(alertWorkerIntervalMs)
  : async () => {};

// Network metrics sampler — every 60s, snapshot per-router bandwidth
// + session counts into router_metrics for the /network history charts.
const stopMetricsWorker = metricsWorkerEnabled
  ? startMetricsWorker(metricsWorkerIntervalMs)
  : async () => {};

const server = app.listen(config.port, () => {
  console.log(`JTM billing API listening on http://localhost:${config.port}`);
  console.log(`  M-Pesa: ${config.mpesa.simulated ? 'SIMULATION' : 'live'} · Stripe: ${config.stripe.simulated ? 'SIMULATION' : 'live'}`);
});

/**
 * Graceful shutdown. K8s sends SIGTERM, then waits terminationGracePeriod
 * before SIGKILL. We stop accepting new connections, let in-flight requests
 * drain, close the DB pool, then exit. A hard timeout guarantees we still exit
 * if a request hangs. Idempotent against repeated signals.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', msg: 'shutdown_start', signal }));

  const hardTimeout = setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', msg: 'shutdown_forced' }));
    process.exit(1);
  }, 10_000);
  hardTimeout.unref();

  server.close(async () => {
    try {
      await stopPaymentWorker(); // let in-flight payment jobs finish
    } catch (e) {
      console.error('[shutdown] payment worker stop failed:', e);
    }
    try {
      await stopExpireWorker(); // let an in-flight expiry sweep finish
    } catch (e) {
      console.error('[shutdown] expire worker stop failed:', e);
    }
    try {
      await stopAlertWorker(); // let an in-flight alert sweep finish
    } catch (e) {
      console.error('[shutdown] alert worker stop failed:', e);
    }
    try {
      await stopMetricsWorker(); // let an in-flight metrics sample finish
    } catch (e) {
      console.error('[shutdown] metrics worker stop failed:', e);
    }
    try {
      await pool.end();
    } catch {
      /* pool may already be closed */
    }
    clearTimeout(hardTimeout);
    console.log(JSON.stringify({ level: 'info', msg: 'shutdown_complete' }));
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
