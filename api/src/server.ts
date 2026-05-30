import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = await createApp();

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
